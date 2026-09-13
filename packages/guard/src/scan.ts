/**
 * Deterministic diff/idea screening — the automated half of the merge gate.
 * `block` findings stop auto-merge and route the PR to a human; `warn`
 * findings are surfaced on the card but don't stop the pipeline.
 *
 * Two surfaces:
 *  - scanChangedPaths / scanPatchText — the agent's diff before merge or commit
 *  - screenFeatureIdea — raw Slack intake text before it reaches a model
 */

export interface ScanFinding {
  /**
   * block — the change must never be committed (self-modification, secrets).
   * hold  — fine on a branch, but stops auto-merge pending human review.
   * warn  — surfaced to the PM, doesn't stop anything.
   */
  severity: 'block' | 'hold' | 'warn';
  rule: string;
  path?: string;
  detail: string;
}

/** Paths an agent diff must never touch — CI, review config, agent config, env. */
const BLOCKED_PATHS: { re: RegExp; rule: string }[] = [
  { re: /(^|\/)\.github\/workflows\//, rule: 'ci-workflow' },
  { re: /(^|\/)\.github\/CODEOWNERS$|(^|\/)CODEOWNERS$/, rule: 'codeowners' },
  { re: /(^|\/)\.githooks\/|(^|\/)\.husky\//, rule: 'git-hooks' },
  { re: /(^|\/)\.env($|\.)/, rule: 'env-file' },
  { re: /(^|\/)(AGENTS|CLAUDE|GEMINI)\.md$/, rule: 'agent-config' },
  { re: /(^|\/)\.(devin|claude|cursor|codeium)\//, rule: 'agent-config' },
  { re: /(^|\/)\.github\/(dependabot|renovate)\.ya?ml$|(^|\/)renovate\.json$/, rule: 'dep-bot-config' },
];

/** Dependency manifests — agent PRs may not change deps without human review. */
const DEPENDENCY_PATHS: RegExp =
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements.*\.txt|pyproject\.toml|setup\.py|Pipfile(\.lock)?|poetry\.lock|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|Dockerfile.*|docker-compose\.ya?ml)$/;

/** Key-shaped / secret-bearing filenames — warn, not block (test fixtures exist). */
const SENSITIVE_PATHS: RegExp = /(^|\/)[^/]*\.(pem|key|p12|pfx)$|(^|\/)id_[a-z0-9_]+$|(^|\/)\.netrc$/;

/**
 * Invisible code points (zero-width spaces/joiners, bidi controls, tag
 * chars, variation selectors, soft hyphen). Attackers sprinkle them
 * inside trigger words so the text reads "ignore all instructions" to a
 * model but doesn't match the screening regexes — strip before scanning.
 */
export const INVISIBLE_CHARS =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

export function scanChangedPaths(paths: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const p of paths) {
    // Invisibles can smuggle a protected name past the regexes (`.​env`).
    const clean = p.replace(INVISIBLE_CHARS, '');
    for (const { re, rule } of BLOCKED_PATHS) {
      if (re.test(clean)) {
        findings.push({
          severity: 'block',
          rule,
          path: p,
          detail: `diff touches protected path (${rule})`,
        });
        break;
      }
    }
    if (DEPENDENCY_PATHS.test(clean)) {
      findings.push({
        severity: 'hold',
        rule: 'dependency-change',
        path: p,
        detail: 'dependency manifest changed — a human reviews before merge',
      });
    }
    if (SENSITIVE_PATHS.test(clean)) {
      findings.push({
        severity: 'warn',
        rule: 'sensitive-path',
        path: p,
        detail: 'key-shaped filename in diff',
      });
    }
  }
  return findings;
}

/** Content patterns checked against *added* lines of a unified diff. */
const CONTENT_RULES: { re: RegExp; severity: ScanFinding['severity']; rule: string; detail: string }[] = [
  { re: /\beval\s*\(|new\s+Function\s*\(/, severity: 'block', rule: 'dynamic-eval', detail: 'eval()/new Function() introduced' },
  { re: /child_process|execSync\s*\(|spawnSync\s*\(/, severity: 'block', rule: 'process-spawn', detail: 'spawns child processes' },
  { re: /\b(atob|unescape)\s*\(\s*['"][A-Za-z0-9+/=]{120,}/, severity: 'block', rule: 'encoded-payload', detail: 'decodes a large embedded payload' },
  { re: /(['"`])[A-Za-z0-9+/]{300,}={0,2}\1/, severity: 'block', rule: 'base64-blob', detail: 'large opaque blob literal' },
  { re: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, severity: 'warn', rule: 'raw-ip-url', detail: 'URL to a raw IP address' },
  { re: /\b(fetch|axios\.(get|post)|https?\.request)\s*\(/, severity: 'warn', rule: 'new-egress', detail: 'new outbound network call — confirm the destination' },
  { re: /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/, severity: 'warn', rule: 'env-read', detail: 'reads a secret-shaped env var' },
];

/** Known token/credential shapes — a leak means exfiltration, always block. */
const SECRET_SHAPES: { re: RegExp; rule: string }[] = [
  { re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}/, rule: 'github-token' },
  { re: /sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{30,}/, rule: 'llm-key' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, rule: 'slack-token' },
  { re: /A(?:KIA|SIA|BIA|CIA|DIA|GPA|IDA|IPA|ROA)[0-9A-Z]{16}/, rule: 'aws-key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY/, rule: 'private-key' },
  { re: /glpat-[A-Za-z0-9_-]{15,}|AIza[0-9A-Za-z_-]{20,}/, rule: 'other-token' },
];

/** `+` lines of a unified diff (skips the +++ header line). */
function addedLines(patch: string): string[] {
  return patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

export function scanPatchText(patch: string, path?: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  // Strip invisibles so `ghp_​…`-style smuggling still matches the shapes.
  for (const line of addedLines(patch.replace(INVISIBLE_CHARS, ''))) {
    for (const { re, severity, rule, detail } of CONTENT_RULES) {
      if (re.test(line)) {
        findings.push({ severity, rule, path, detail });
      }
    }
    for (const { re, rule } of SECRET_SHAPES) {
      if (re.test(line)) {
        findings.push({
          severity: 'block',
          rule: `secret-${rule}`,
          path,
          detail: `credential-shaped string committed (${rule})`,
        });
      }
    }
  }
  return findings;
}

export interface PrFileLike {
  filename: string;
  status?: string;
  patch?: string;
}

/** One pass over a PR file list (paths + per-file patches). */
export function scanPrFiles(files: PrFileLike[]): ScanFinding[] {
  const findings = scanChangedPaths(files.map((f) => f.filename));
  for (const f of files) {
    if (f.patch) findings.push(...scanPatchText(f.patch, f.filename));
  }
  return findings;
}

export function summarizeFindings(findings: ScanFinding[], max = 8): string {
  const icon = { block: '🚫', hold: '✋', warn: '⚠️' } as const;
  return findings
    .slice(0, max)
    .map((f) => `${icon[f.severity]} ${f.path ? `\`${f.path}\` — ` : ''}${f.detail}`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Intake screening — the Slack idea text before it reaches any model.  */
/* ------------------------------------------------------------------ */

export interface IdeaScreen {
  verdict: 'ok' | 'flag' | 'block';
  reasons: string[];
}

const INJECTION_PATTERNS: { re: RegExp; reason: string; block: boolean }[] = [
  { re: /ignore\s+(all\s+|any\s+|previous\s+|prior\s+)*(instructions|prompts|rules)/i, reason: 'instruction-override', block: true },
  { re: /\b(system|developer)\s+(prompt|message|mode)\b/i, reason: 'prompt-probe', block: true },
  { re: /you\s+are\s+now\s+(a|an|the)\b|act\s+as\s+(if\s+you|a|an|the)\b/i, reason: 'persona-override', block: true },
  { re: /\bjailbreak\b|\bDAN\b|do\s+anything\s+now/i, reason: 'jailbreak', block: true },
  { re: /(curl|wget)\s+[^\s|]*\|?\s*(sh|bash)|curl\s+-[a-zA-Z]*\s*https?:\/\//i, reason: 'shell-exec-request', block: true },
  { re: /base64\s+(-d|--decode)|eval\s*\(/i, reason: 'encoded-exec-request', block: true },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY/, reason: 'embedded-key', block: true },
  { re: /\bmerge\s+(this|the)\s+(pr|pull|branch)|push\s+to\s+main\b|delete\s+the\s+repo/i, reason: 'repo-manipulation', block: true },
  { re: /https?:\/\/[^\s]+/i, reason: 'contains-url', block: false },
];

/**
 * Screen a raw feature request. `block` = reject at intake; `flag` = run but
 * record the reasons on the audit trail; `ok` = clean.
 */
export function screenFeatureIdea(text: string, maxChars = 2_000): IdeaScreen {
  const reasons: string[] = [];
  let block = false;
  if (text.length > maxChars) {
    return { verdict: 'block', reasons: [`exceeds ${maxChars} chars`] };
  }
  const cleaned = text.replace(INVISIBLE_CHARS, '');
  if (cleaned !== text) reasons.push('zero-width-chars');
  const urls = cleaned.match(/https?:\/\/[^\s]+/g) ?? [];
  if (urls.length > 3) reasons.push('url-flood');
  for (const { re, reason, block: b } of INJECTION_PATTERNS) {
    if (re.test(cleaned)) {
      reasons.push(reason);
      if (b) block = true;
    }
  }
  return { verdict: block ? 'block' : reasons.length ? 'flag' : 'ok', reasons };
}

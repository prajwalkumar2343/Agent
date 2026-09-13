/**
 * Shell environment policy for the agent's runShell — codex's
 * ShellEnvironmentPolicy equivalent. Instead of a fixed name denylist
 * (which silently misses the next secret a workstream adds), names are
 * excluded by *word segments*: any env var containing KEY, SECRET, TOKEN,
 * PASSWORD, CREDENTIAL, AUTH, PAT, or PRIVATE as a `_`-separated segment is
 * dropped unless ops force-includes it via SHELL_ENV_ALLOW.
 */

const EXCLUDED_WORDS = new Set([
  'KEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'PAT',
  'PRIVATE',
]);

/** Explicit names — backstop for secrets that don't match word segments. */
const EXCLUDED_NAMES = new Set(['GH_AGENT_PAT', 'PI_API_KEY']);

function isSecretName(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  return name
    .split(/[_\-.]/)
    .some((seg) => EXCLUDED_WORDS.has(seg.toUpperCase()));
}

export interface EnvPolicyResult {
  env: Record<string, string>;
  dropped: string[];
}

/**
 * Filter a process env for agent-shell use.
 *   SHELL_ENV_ALLOW="FOO,BAR"  force-includes names even when secret-shaped
 *   SHELL_ENV_DENY="BAZ"       force-excludes extra names
 */
export function scrubEnv(
  source: NodeJS.ProcessEnv = process.env,
  env: NodeJS.ProcessEnv = process.env,
): EnvPolicyResult {
  const allow = new Set(
    (env.SHELL_ENV_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const extraDeny = new Set(
    (env.SHELL_ENV_DENY ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if ((isSecretName(k) && !allow.has(k)) || extraDeny.has(k)) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  return { env: out, dropped };
}

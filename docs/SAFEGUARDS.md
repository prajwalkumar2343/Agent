# Safeguards

The pipeline turns arbitrary Slack text into merged code on a product repo.
Safeguards are layered so that no single failure — a prompt injection, a
spammy requester, a compromised sandbox — can reach `main` or production.

Design rule: **enforce at the permission/infra layer, not the prompt
layer.** Prompt instructions are hints; guards below are code and platform
controls the model cannot talk its way past.

## Layer map

```
Slack text ──▶ intake gate ──▶ spec/spec card ──▶ orchestrator ──▶ pi in VM
 (untrusted)   paused?         (untrusted data    (denylisted      (GH_TOKEN
               allowlist        in model ctx)      shell, read-     scoped to
               screening                          only git)       agent/* —
                                                  fixed branch)   sealed git)
               rate limit
               dedup                          ──▶ pi pushes ──▶ PR ──▶ merge gate ──▶ flag
                                                  agent/* only       CI green +        ≤ cap
                                                  (branch fixed      diff scan
                                                   upstream)         (else human)
```

## 1. Branch protection — the agent cannot touch main

- **`assertAgentBranch()` in `cli.ts`** — the branch pi gets is computed
  upstream (`agent/<slug>-<thread_ts>`) and asserted before anything runs:
  only `agent/*` names (≠ base, well-formed) ever reach the sandbox's git
  target. pi's prompt pins that branch — it never chooses one.
- **Protected paths** — pi's prompt bans `.github/workflows`, CODEOWNERS,
  hooks, `.env*`, agent config; the applied-diff scan in `vmCoder.ts`
  surfaces violations to the orchestrator, and the merge gate's PR diff
  scan is the enforcement that can't be talked past.
- **Workflow** (`feature-run.yml`): `permissions: contents: read` for the
  job token; product checkout uses `persist-credentials: false` so the PAT
  never lands in the shipped `.git/config` — it crosses as `GH_TOKEN` in
  pi's env instead.
- **Sandbox** (`sandbox/e2b.ts`, `local.ts` + `sanitizeRepoScript` /
  `configureRemoteScript`): the shipped repo has every remote and
  http/url/credential config stripped, then origin is re-added through a
  credential helper that reads `$GH_TOKEN` from the process env at push
  time — the token value never sits in `.git/config`. `GIT_TERMINAL_PROMPT=0`,
  `GIT_CONFIG_GLOBAL=/dev/null` etc. keep every other auth path dead (no
  prompts, no askpass, no ssh, no host config leaking in).
- **Repo level**: `scripts/protect-product-repo.sh` applies PR-required
  protection on the default branch + a path-restriction ruleset (where the
  plan supports it). This is now the hard backstop — a credentialed pi could
  attempt `git push origin main`, and protection rejects it. `GH_AGENT_PAT`
  must be fine-grained with `contents:write` + `pull_requests:write` and
  **no `workflows` scope**.

## 2. Prompt injection

- **Intake screening** (`guard/scan.ts: screenFeatureIdea`) — override
  phrases, shell/exec requests, embedded keys, URL floods, zero-width chars;
  `block` rejects, `flag` proceeds with an audit record + thread notice.
- **Untrusted-data framing** in `spec.ts`, `ORCHESTRATOR_SYSTEM`, and the
  sandbox task prompt: file contents/comments/task text are data, never
  instructions.
- **`runShell` policy engine** (`guard/shell.ts` — modeled on codex's
  execpolicy): commands are lexed into individual argv segments — pipes,
  `&&`, subshells, `$( )`/backtick substitutions are all split and vetted
  separately; wrappers (`env`, `nice`, `timeout`...) unwrap to the real
  argv0. Quote-concatenation (`g"it" push`), substitution smuggling, and
  `sh -c` recursion all resolve to the denied command. git is allowlist-only
  (read subcommands), egress/publisher/privilege tools are forbidden,
  `cd`/redirects/`rm`/path args can't leave the workspace or touch
  `.git`/`.env*`/key files, and unparseable syntax is denied outright.
  Ops can add forbidden prefixes without redeploy via `SHELL_DENY_PREFIXES`.
- **Env policy** (`guard/envpol.ts` — codex's ShellEnvironmentPolicy):
  pattern-based scrub — any var with a `KEY`/`SECRET`/`TOKEN`/`PASSWORD`/
  `CREDENTIAL`/`AUTH`/`PAT`/`PRIVATE` name segment is dropped, plus an
  explicit backstop list; `SHELL_ENV_ALLOW`/`SHELL_ENV_DENY` tune it.
  Git is env-sealed (no global config, no credential prompts).
- **Secret vault** (`shared/src/vault.ts`): pipeline env vars never sit on
  agent-adjacent objects. Tool contexts and provider configs carry
  `SecretRef` keywords (`vault:NAME`) — the GH PAT, PostHog key, run
  callback secret, and pi's LLM key all cross as refs and resolve inside
  tool implementations at the moment they're spent (an Authorization
  header, a child-process spawn). A raw value passed where a ref is
  expected throws, and scoped vaults (`envVault(env, allow)`) close the
  keyword space to the names a run declares. There is intentionally no
  tool that resolves a ref into model context.
- **File-tool protection** (`tools/workspace.ts`): `readFile`/`writeFile`/
  `listFiles` deny `.git/**`, `.env*`, `.ssh`, key-shaped paths — secrets
  committed to the product repo can't be read, and `.git` can't be tampered
  with (codex's `.git`-read-only workspace rule).
- **Sandbox boundary**: the VM sees only the repo + its own LLM key — never
  `GH_AGENT_PAT`, Slack/KV/PostHog secrets (`sandbox/types.ts`).
- **Signed control plane**: Slack HMAC + `team_id`, GitHub webhook HMAC
  (fail-closed; `ALLOW_INSECURE_WEBHOOKS` is a dev-only escape), shared
  `x-run-secret` on run callbacks. Text alone can never fake an approval.

## 3. Malicious feature / backdoor — the merge gate

`api/github/webhook.ts` runs two layers over the PR file list + patches
before merge:

**Deterministic scan** (`guard/scan.ts`):

- **block** — protected paths, `eval`/`new Function`, `child_process`,
  large encoded blobs, credential-shaped strings → never committed/merged.
- **hold** — dependency-manifest changes → auto-merge stops, PM is DM'd the
  findings; the PR stays open for human review.
- **warn** — new egress calls, raw-IP URLs, secret-shaped env reads →
  surfaced in audit.

**Second-opinion review** (`guard/review.ts` — codex's guardian subsystem):
a separate model sees ONLY the spec + the diff and answers "does this do
anything beyond the spec?" — `suspicious` holds the merge with reasons for
the PM. Runs when `ANTHROPIC_API_KEY` is set on Vercel; `MERGE_REVIEW=0`
disables, `MERGE_REVIEW_MODEL` overrides the model (default haiku tier).
Fail-open on reviewer errors — the deterministic scan is the always-on layer.

## 4. Spam / abuse

`guard/intake.ts: checkIntake` (KV-backed, in-memory fallback for dev):
`AGENT_PAUSED` kill switch → `INTAKE_USER_IDS`/`INTAKE_CHANNEL_IDS`
allowlists → `INTAKE_PER_USER_PER_DAY`/`INTAKE_PER_DAY`/`INTAKE_MAX_ACTIVE`
caps → `INTAKE_DEDUP_MINUTES` duplicate window. Rejected requests get a
polite reply and an audit entry.

## 5. Blast radius

- `MAX_VM_INVOCATIONS` caps pi calls per run; `VM_TIMEOUT_MS` caps each
  call; the Actions job itself has `timeout-minutes`.
- `ROLLOUT_MAX_PCT` caps the automated flag path; higher = a human in
  PostHog. Buttons re-check PM allowlist + pct at click time.
- `DEPLOY_MAX_USERS` caps Postgres cohort deploys the same way;
  `/api/deploy/users` is `x-run-secret`-authed and a `thread_ts` that
  resolves to a run must own the `flag_key` — the agent's `deploy_to_users`
  can only ever touch its own run's flag. `DEPLOY_ALLOW_SEED` gates demo
  user-seeding (off by default).
- `runs/complete` validates `agent/*` branch shape + product-repo PR URLs
  before accepting a build result.
- **Audit**: `guard/audit.ts` writes every gate decision to stdout (queryable
  in Vercel/Actions logs) and a capped `guard:audit` KV list.
- **Manual steps** (outside this repo): E2B template egress firewall to
  github.com + registries only; fine-grained PAT scoping; branch protection
  script; Slack app installed to a restricted channel.

# packages/runner — agent harness (A7)

Minimal pi-code-style harness on the Vercel AI SDK: orchestrator → pi-in-VM.
pi owns the change end to end — there is no second agent. Runs inside
`.github/workflows/feature-run.yml` (A8) on a checked-out copy of the product
repo:

```
orchestrator (harness, trusted zone)
  listFiles / readFile / runShell    orient + verify (no writeFile — read-only-ish)
  posthog            (MCP)
  deploy_to_users    → POST /api/deploy/users — Postgres cohort, flag pinned
  delegate_to_vm_coder ─────────▶ pi coding agent in an isolated VM (untrusted)
        ▲                            tarball in → pi edits, commits, pushes the
        └─ patch applied locally +     fixed agent/* branch, opens the PR itself
           report as tool result       (git push via $GH_TOKEN credential helper
                                       + REST POST /pulls) → cumulative
                                       git diff + report.md out
```

The orchestrator never edits the repo — pi is the only writer and the only
remote-state owner. Its diff is applied to the local checkout inside the
delegate tool (`git checkout -- . && git clean -fd && git apply`), the
orchestrator re-runs the repo's checks in the trusted zone, then
re-delegates on failure. Repeat `delegate_to_vm_coder` calls continue on the
same sandbox tree — that's how "fix this test failure" retries work; the
patch is always the cumulative diff vs base, reset+apply keeps the local
mirror exact, and pi pushes follow-up commits onto the same branch/PR.

## Design rules

- **Deterministic invariants are baked into config, never model-chosen:**
  `branch = agent/<slug>-<thread_ts>` is computed in `cli.ts` and pinned in
  the sandbox's git target (`SandboxGitTarget`); pi's prompt gets the fixed
  branch/base/repo, not a choice.
- **The choreography lives in code.** The vm-coder tool resets+applies the
  patch itself — the model calls one tool. The remote URL, committer
  identity, and `$GH_TOKEN` credential helper are configured by the
  provider's ship script (`configureRemoteScript`), not by pi.
- **The sandbox is the untrusted zone — but it can now push.** The VM sees
  the repo tarball, pi's LLM key (`PI_API_KEY`), and `GH_TOKEN`
  (`GH_AGENT_PAT`) so pi can push its fixed `agent/*` branch and open the
  PR itself. What keeps `main` safe: the branch name is fixed upstream,
  pi's prompt scopes remote writes to it, the shipped `.git` is sanitized
  (all remotes/credential config stripped, then re-pointed at origin through
  an env-fed credential helper — the token never sits in `.git/config`),
  git is sealed to non-interactive auth (no prompts, no askpass, no ssh,
  no host config), and the product repo's branch protection still requires
  a PR on the default branch. The callback secret and Slack/KV/PostHog
  secrets still never cross the boundary.
- **Verify in the trusted zone.** A VM's "tests pass" or "PR opened" claim
  isn't trusted — the orchestrator re-runs checks locally on the mirrored
  diff, and `cli.ts` reports success only when a real PR URL comes back in
  pi's report.
- **Secrets never enter model context — or agent-adjacent objects.**
  `GH_AGENT_PAT`, the PostHog key, the run-callback secret, and pi's LLM key
  all flow through configs as `vault:NAME` keyword refs
  (`shared/src/vault.ts`), resolved inside tool implementations at the
  moment of use (auth headers, the pi process spawn). A raw value passed
  where a ref is expected throws. On top of that, the orchestrator's
  `runShell` gets an env denylist (`GH_AGENT_PAT`, `ANTHROPIC_API_KEY`,
  `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `E2B_API_KEY`, `PI_API_KEY`,
  `RUN_CALLBACK_SECRET`, Slack/KV/PostHog secrets) so a prompt-injected repo
  file can't exfiltrate.
- The orchestrator's git is **read-only** (`status`/`diff`/`log`) — all
  remote state belongs to pi inside the VM. `cli.ts` posts the
  `RunsCompletePayload` callback itself (success requires a `pr_url`; no PR
  → `failed`).

## Invocation (feature-run.yml)

```bash
node --experimental-strip-types packages/runner/src/cli.ts
```

Env:

| Var | Source |
|---|---|
| `THREAD_TS`, `SPEC_JSON`, `FEATURE_CONTEXT_JSON`, `EVIDENCE_JSON`, `FLAG_KEY` | workflow_dispatch inputs (`*_JSON` are `JSON.stringify`ed; empty/`{}` = absent) |
| `PRODUCT_REPO` / `PRODUCT_REPO_DIR` | owner/name + checkout dir (default cwd) |
| `GH_AGENT_PAT` | product repo contents+PRs write — crosses into the sandbox as `GH_TOKEN`; pi spends it on the `agent/*` push + PR |
| `CALLBACK_URL` / `RUN_CALLBACK_SECRET` | `/api/runs/complete` + `x-run-secret` |
| `LLM_PROVIDER` / `LLM_MODEL` | orchestrator LLM — `anthropic` (default), `openrouter`, or `opencode` (OpenCode Zen). Key comes from `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENCODE_API_KEY`; model defaults are per-provider (`ANTHROPIC_MODEL` still honored for anthropic) |
| `SANDBOX_PROVIDER` | `e2b` (default when `E2B_API_KEY` set) or `local` (pi as a local child process — dev/tests) |
| `E2B_API_KEY` / `E2B_TEMPLATE` | e2b auth + template (default `base`; bootstrap installs node+pi) |
| `PI_PROVIDER` / `PI_MODEL` / `PI_API_KEY` | pi's LLM — defaults anthropic / `claude-sonnet-4-5`; `openrouter`, `opencode`, `opencode-go`, `openai`, `google`, `groq`, `mistral` also work. Key defaults to the provider's env var (`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, …) unless `PI_API_KEY` overrides it. The VM sees this key plus `GH_TOKEN`. |
| `VM_TIMEOUT_MS` | per-invocation pi budget, default 15 min |
| `POSTHOG_API_KEY` / `POSTHOG_PROJECT_ID` / `POSTHOG_MCP_URL` | optional — with a key the orchestrator gets the `posthog` tool (MCP session pinned to the project, scoped to flags/events/sql/insights/replay; delete/archive/switch tools denied) |
| `DEPLOY_API_URL` | optional override for the `deploy_to_users` endpoint — defaults to `/api/deploy/users` on the `CALLBACK_URL` host. Postgres creds (`POSTGRES_URL`) live only in the app env; the tool sends the run secret + the run's pinned flag_key |
| `RUNNER_BASE_BRANCH` | default `main` |
| `LOG_URL` | optional Actions run URL, echoed back as `log_url` |
| `RUN_RESULT_PATH` | debug copy of the outcome, default `run-result.json` (includes per-VM-call summary) |
| `RUN_TRACE_PATH` | opt-in span-contract trace for evals |
| `RUN_VM_EVENTS_PATH` | optional — pi's raw JSONL event streams, one per VM call |

Callback: `POST CALLBACK_URL` with `RunsCompletePayload` — success requires a
`pr_url`; if the run throws or the agent never delegates, `status: 'failed'`.

## Files

```
src/harness.ts            createHarness — the shared loop
src/sandbox/types.ts      SandboxProvider port + shared VM choreography + pi's system prompt
src/sandbox/e2b.ts        E2B Firecracker microVM: tarball ship, pi bootstrap, diff collect
src/sandbox/local.ts      pi as a local child process (dev/tests, no E2B needed)
src/sandbox/index.ts      sandboxFromEnv — provider selection + pi env mapping
src/agents/orchestrator.ts primary: system prompt, read-only tools + delegate_to_vm_coder
src/tools/workspace.ts    listFiles / readFile / writeFile / runShell
src/tools/vmCoder.ts      delegate_to_vm_coder — runTask → reset+apply patch → report
src/tools/posthog.ts      `posthog` — one tool, CLI-style dispatcher over PostHog MCP (tools/search/info/schema/call)
src/tools/deploy.ts       `deploy_to_users` — user-count cohort deploys via the app's internal endpoint
src/callback.ts           postRunComplete — POST /api/runs/complete + x-run-secret
src/cli.ts                env → orchestrator → callback + run-result.json
evals/src/sandbox-mock.ts EvalSandbox — fake VM for evals (vm_script writes → diff + simulated remote writes)
```

Adding a tool = add it to the agent's `tools` in `agents/*.ts`. Adding another
sandbox backend = implement `SandboxProvider` and register it in
`sandbox/index.ts`.

## Notes

- Everything runs under `node --experimental-strip-types`: relative imports
  need explicit `.ts`; `packages/shared` runtime values import from leaf files
  (`../../shared/src/contracts.ts`) since its `index.ts` re-exports are
  extensionless. No TS parameter properties (`private x:` ctor params) —
  strip-types can't compile them.
- E2B `base` template has no node — `e2b.ts` bootstraps a userspace node
  tarball + `npm i -g @mariozechner/pi-coding-agent` on first use. Bake both
  into a custom template (`E2B_TEMPLATE`) to cut ~20–30s per run.
- pi runs `--mode json --no-session --no-approve` — JSONL events on stdout,
  no session persistence, repo-supplied pi resources not auto-trusted.

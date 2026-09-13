# packages/runner — agent harness (A7)

Minimal pi-code-style harness on the Vercel AI SDK, with a three-way split:
orchestrator → VM coder → github agent. Runs inside
`.github/workflows/feature-run.yml` (A8) on a checked-out copy of the product
repo:

```
orchestrator (harness, trusted zone)
  listFiles / readFile / runShell    orient + verify (no writeFile — read-only-ish)
  posthog            (MCP)
  delegate_to_vm_coder ─────────▶ pi coding agent in an isolated VM (untrusted)
        ▲                            tarball in → pi edits → cumulative
        └─ patch applied locally +     git diff + report.md out
           report as tool result
  delegate_to_github ───────────▶ github agent (secondary)
                                     createBranch     (git/refs)
                                     commitChanges  (blobs→tree→commit→ref)
                                     openPR         (pulls)
                                     readRemoteFile / listRemoteFiles
```

The orchestrator never edits the repo — the VM coder is the only writer. Its
diff is applied to the local checkout inside the delegate tool
(`git checkout -- . && git clean -fd && git apply`), the orchestrator
re-runs the repo's checks in the trusted zone, then hands off. Repeat
`delegate_to_vm_coder` calls continue on the same sandbox tree — that's how
"fix this test failure" retries work; the patch is always the cumulative
diff vs base, and reset+apply keeps the local mirror exact.

## Design rules

- **Deterministic invariants are baked into tool implementations**, never
  model-chosen: `branch = agent/<slug>-<thread_ts>` is computed in `cli.ts`
  and fixed inside `GithubToolsContext`; `openPR` gets only title+body.
- **The choreography lives in code.** `commitChanges` collects the dirty
  working tree (`git status --porcelain`) and does blobs → tree → commit →
  ref update itself; the vm-coder tool resets+applies the patch itself — the
  model calls one tool.
- **The sandbox is the untrusted zone.** The VM sees only the repo tarball
  and pi's LLM key (`PI_API_KEY`) — `GH_AGENT_PAT`, the callback secret,
  Slack/KV/PostHog secrets never cross the boundary. The VM can never push:
  remote state stays with the GitHub agent in the trusted zone.
- **Verify in the trusted zone.** A VM's "tests pass" claim isn't trusted —
  the orchestrator re-runs checks locally before delegating to GitHub.
- **Secrets never enter model context.** `GH_AGENT_PAT` is used inside the
  GitHub tool functions only; the orchestrator's `runShell` gets an env
  denylist (`GH_AGENT_PAT`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
  `OPENCODE_API_KEY`, `E2B_API_KEY`, `PI_API_KEY`,
  `RUN_CALLBACK_SECRET`, Slack/KV/PostHog secrets) so a prompt-injected repo
  file can't exfiltrate.
- The orchestrator's git is **read-only** (`status`/`diff`/`log`) — all remote
  state belongs to the GitHub agent. `cli.ts` posts the `RunsCompletePayload`
  callback itself (success requires a `pr_url`; no PR → `failed`).

## Invocation (feature-run.yml)

```bash
node --experimental-strip-types packages/runner/src/cli.ts
```

Env:

| Var | Source |
|---|---|
| `THREAD_TS`, `SPEC_JSON`, `FEATURE_CONTEXT_JSON`, `EVIDENCE_JSON`, `FLAG_KEY` | workflow_dispatch inputs (`*_JSON` are `JSON.stringify`ed; empty/`{}` = absent) |
| `PRODUCT_REPO` / `PRODUCT_REPO_DIR` | owner/name + checkout dir (default cwd) |
| `GH_AGENT_PAT` | product repo contents+PRs write |
| `CALLBACK_URL` / `RUN_CALLBACK_SECRET` | `/api/runs/complete` + `x-run-secret` |
| `LLM_PROVIDER` / `LLM_MODEL` | orchestrator + github agent LLM — `anthropic` (default), `openrouter`, or `opencode` (OpenCode Zen). Key comes from `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENCODE_API_KEY`; model defaults are per-provider (`ANTHROPIC_MODEL` still honored for anthropic) |
| `SANDBOX_PROVIDER` | `e2b` (default when `E2B_API_KEY` set) or `local` (pi as a local child process — dev/tests) |
| `E2B_API_KEY` / `E2B_TEMPLATE` | e2b auth + template (default `base`; bootstrap installs node+pi) |
| `PI_PROVIDER` / `PI_MODEL` / `PI_API_KEY` | pi's LLM — defaults anthropic / `claude-sonnet-4-5`; `openrouter`, `opencode`, `opencode-go`, `openai`, `google`, `groq`, `mistral` also work. Key defaults to the provider's env var (`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, …) unless `PI_API_KEY` overrides it. `PI_API_KEY` is the only secret the VM sees. |
| `VM_TIMEOUT_MS` | per-invocation pi budget, default 15 min |
| `POSTHOG_API_KEY` / `POSTHOG_PROJECT_ID` / `POSTHOG_MCP_URL` | optional — with a key the orchestrator gets the `posthog` tool (MCP session pinned to the project, scoped to flags/events/sql/insights/replay; delete/archive/switch tools denied) |
| `RUNNER_BASE_BRANCH` | default `main` |
| `LOG_URL` | optional Actions run URL, echoed back as `log_url` |
| `RUN_RESULT_PATH` | debug copy of the outcome, default `run-result.json` (includes per-VM-call summary) |
| `RUN_TRACE_PATH` | opt-in span-contract trace for evals |
| `RUN_VM_EVENTS_PATH` | optional — pi's raw JSONL event streams, one per VM call |

Callback: `POST CALLBACK_URL` with `RunsCompletePayload` — success requires a
`pr_url`; if the run throws or the agent never delegates, `status: 'failed'`.

## Files

```
src/harness.ts            createHarness — the shared loop (both agents use it)
src/sandbox/types.ts      SandboxProvider port + shared VM choreography
src/sandbox/e2b.ts        E2B Firecracker microVM: tarball ship, pi bootstrap, diff collect
src/sandbox/local.ts      pi as a local child process (dev/tests, no E2B needed)
src/sandbox/index.ts      sandboxFromEnv — provider selection + pi env mapping
src/agents/orchestrator.ts primary: system prompt, read-only tools + both delegates
src/agents/github.ts      secondary: runGithubAgent + delegate_to_github tool
src/tools/workspace.ts    listFiles / readFile / writeFile / runShell
src/tools/vmCoder.ts      delegate_to_vm_coder — runTask → reset+apply patch → report
src/tools/github.ts       createBranch / commitChanges / openPR / readRemoteFile / listRemoteFiles
src/tools/posthog.ts      `posthog` — one tool, CLI-style dispatcher over PostHog MCP (tools/search/info/schema/call)
src/callback.ts           postRunComplete — POST /api/runs/complete + x-run-secret
src/cli.ts                env → orchestrator → callback + run-result.json
evals/src/sandbox-mock.ts EvalSandbox — fake VM for evals (vm_script writes → diff)
```

Adding a tool = add it to the agent's `tools` in `agents/*.ts`. Adding another
sandbox backend = implement `SandboxProvider` and register it in
`sandbox/index.ts`. Adding a third agent = another `agents/*.ts` + a delegate
tool on the caller's toolset.

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

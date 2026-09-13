# packages/runner — agent harness (A7)

Minimal pi-code-style harness on the Vercel AI SDK, with a two-agent split.
Runs inside `.github/workflows/feature-run.yml` (A8) on a checked-out copy of
the product repo:

```
coding agent (primary)                     github agent (secondary)
  listFiles / readFile                       createBranch     (git/refs)
  writeFile / runShell   ── delegate_to_github ─▶  commitChanges  (blobs→tree→commit→ref)
        ▲                                    openPR         (pulls)
        └──────── tool result (report) ───────┘   readRemoteFile / listRemoteFiles
```

The primary edits the local working tree and verifies with the repo's checks;
`delegate_to_github` suspends its loop while the secondary agent runs; the
secondary's final message returns as the tool result and the primary resumes
to write the report. Handoff and "invoke primary back" in one tool call.

## Design rules

- **Deterministic invariants are baked into tool implementations**, never
  model-chosen: `branch = agent/<slug>-<thread_ts>` is computed in `cli.ts`
  and fixed inside `GithubToolsContext`; `openPR` gets only title+body.
- **The choreography lives in code.** `commitChanges` collects the dirty
  working tree (`git status --porcelain`) and does blobs → tree → commit →
  ref update itself — the model calls one tool.
- **Secrets never enter model context.** `GH_AGENT_PAT` is used inside the
  GitHub tool functions only; the coding agent's `runShell` gets an env
  denylist (`GH_AGENT_PAT`, `ANTHROPIC_API_KEY`, `RUN_CALLBACK_SECRET`,
  Slack/KV/PostHog secrets) so a prompt-injected repo file can't exfiltrate.
- The coding agent's git is **read-only** (`status`/`diff`/`log`) — all remote
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
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | provider; model defaults `claude-sonnet-4-5` |
| `RUNNER_BASE_BRANCH` | default `main` |
| `LOG_URL` | optional Actions run URL, echoed back as `log_url` |
| `RUN_RESULT_PATH` | debug copy of the outcome, default `run-result.json` |

Callback: `POST CALLBACK_URL` with `RunsCompletePayload` — success requires a
`pr_url`; if the run throws or the agent never delegates, `status: 'failed'`.

## Files

```
src/harness.ts          createHarness — the shared loop (both agents use it)
src/agents/coding.ts    primary: system prompt, spec prompt, toolset + delegate
src/agents/github.ts    secondary: runGithubAgent + delegate_to_github tool
src/tools/workspace.ts  listFiles / readFile / writeFile / runShell
src/tools/github.ts     createBranch / commitChanges / openPR / readRemoteFile / listRemoteFiles
src/callback.ts         postRunComplete — POST /api/runs/complete + x-run-secret
src/cli.ts              env → coding agent → callback + run-result.json
```

Adding a tool = add it to the agent's `tools` in `agents/*.ts`. Adding a third
agent = another `agents/*.ts` + a delegate tool on the caller's toolset.

## Notes

- Everything runs under `node --experimental-strip-types`: relative imports
  need explicit `.ts`; `packages/shared` runtime values import from leaf files
  (`../../shared/src/contracts.ts`) since its `index.ts` re-exports are
  extensionless.

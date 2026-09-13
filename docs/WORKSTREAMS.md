# Workstreams

One workstream per branch/worktree off `main`. You own exactly the paths
listed — everything else is a conflict. `packages/shared` is **frozen**:
if two workstreams need the same code, it lands there via a dedicated PR,
never edited inside a workstream branch.

The base (this commit) ships every package's port + seams. Fill in your
files; don't create new top-level packages or rewire entry points.

| WS | Scope | Paths | Status |
|---|---|---|---|
| A1 | Scaffold: shared contracts, store, provider ports, workflows, docs | `packages/shared`, `packages/store`, `api/_lib`, `.github/workflows`, `docs` | base landed on main |
| A2 | Slack ingress | `api/slack/events.ts`, `api/slack/interactions.ts`, `packages/slack-kit` | landed — intake → build dispatch, thread/DM → rollout/parse, button dispatch |
| A3 | Run pipeline endpoints | `api/runs/complete.ts`, `api/github/webhook.ts` (extends `packages/store`) | base stub works; deepen |
| A4 | Spec generation | `packages/spec` | port + impl landed |
| A5 | Docs feature check | `packages/mintlify` (evidence composition) | client landed |
| A6 | PostHog evidence + sim | `packages/posthog/src/evidence.ts`, `packages/sim` | evidence via MCP landed; sim mock landed |
| A7 | Coding agent | `packages/runner` (prompt, tools, cli, evals) | orchestrator → pi-in-VM (`delegate_to_vm_coder`) → github agent per `docs/RUNNER.md`; sandbox port: e2b + local; `posthog` MCP tool wired |
| A8 | Actions plumbing | `.github/workflows/feature-run.yml`, `sweep.yml` | landed — workflow just invokes `packages/runner/src/cli.ts` |
| A9 | Rollout control | `api/rollout/parse.ts`, `packages/posthog/src/flags.ts`, button handling in interactions | flags over MCP landed |
| A10 | Metrics + sweep | `api/cron/sweep.ts` `metricLine`, `packages/posthog/src/metrics.ts` | metrics over MCP landed |
| A11 | User-count deploys | `packages/deploy`, `api/deploy/users.ts`, `deploy_to_users` tool, rollout wiring | Postgres cohort (`feature_cohorts`); PM "N users" + agent-triggerable |

## Wiring notes between workstreams

- **A2 → A9/A10**: `api/slack/events.ts` should forward non-mention messages in
  run threads (and PM DMs) to `api/rollout/parse` as
  `{thread_ts, channel, user, text}` with the `x-run-secret` header.
- **A2 → A9**: `api/slack/interactions.ts` should dispatch on `ACTION.*`:
  `rollout_confirm` → `pending_rollout={pct, confirmed_by}` + state
  `await_ci`; `rollback_confirm` → flag to 0% + state `rolled_back`.
- **A3 → A2**: `api/_lib/notify.ts` duplicates `slack-kit` post/openIm on
  purpose (main can't import a branch). Once A2 merges, re-point `_lib/notify`
  at slack-kit and delete the duplicate.
- **A6 → A3**: `sim_report` rides the `runs/complete` payload — populate it in
  the workflow or leave it absent; the handler copes with either.
- **Everyone → store**: mutate runs only via `transitionRun`/`advance`.

# Architecture

Slack-native feature pipeline on Vercel serverless + GitHub Actions.

```
Slack mention/DM ──▶ api/slack/events ──▶ create run (received)
                                          │ spec ──▶ checked ──▶ evidence ──▶ build
                                          │                          (mintlify + posthog)
                                          ▼
                              workflow_dispatch → feature-run.yml
                                (runner: orchestrator → pi in a sandbox VM —
                                 pi edits, commits, pushes the branch, opens
                                 the PR; patch back, verify)
                                          │ POST /api/runs/complete
                                          ▼
                          reported → await_rollout ◀── PM "roll out to N%"
                              (api/rollout/parse → confirm card)   or "to N users"
                                          │ rollout_confirm / deploy_confirm
                                          │ click → await_ci
                                          ▼
                     api/github/webhook: checks green → merge PR →
                       PostHog flag to N%  |  Postgres cohort to N users
                       (api/deploy/users)   → live ──▶ api/cron/sweep:
                       +12h/+24h/+48h reports → monitor → done
```

## Layers and dependency direction

```
api/            thin Vercel handlers — auth, parse, dispatch, notify. No domain logic.
api/_lib/       shared handler plumbing (raw body, secrets, Slack egress, GitHub REST).
packages/*      domain modules, one boundary each. Import shared contracts only.
packages/shared frozen contracts — types, RunState, payloads, env helpers.
```

Rules that keep this scalable:

- **api → packages → shared.** Packages never import `api/`; packages never
  import each other's implementations — they compose inside handlers via
  `packages/shared` types.
- **Effects behind ports.** `RunStore`, `SimProvider`, `PostHogMcp`,
  `DocsClient` are interfaces; KV/Slack/PostHog-MCP/Mintlify-MCP adapters are
  injectable (`fetchFn`, config objects) so tests need no live services.
  PostHog rides the hosted MCP server (`mcp.posthog.com`) — one transport
  (`packages/posthog/src/mcp.ts`) backs evidence, flags, metrics, and the
  coding agent's `posthog` tool.
- **Auth at the boundary.** Every handler verifies its caller before touching
  state: Slack HMAC + team allowlist, `x-run-secret` for internal endpoints,
  `?secret` for cron, optional `GH_WEBHOOK_SECRET` HMAC, `PM_USER_IDS` for the
  control plane. See `docs/CONTRACTS.md` §Auth boundaries.
- **Cohort deploys live in Postgres.** `packages/deploy` owns
  `feature_cohorts`/`deploy_events` against `POSTGRES_URL` (product `users`
  table is the member source). The coding agent triggers it through
  `POST /api/deploy/users` (run-secret auth, flag pinned to its run,
  `DEPLOY_MAX_USERS` cap) — DB credentials never leave the deployment env.
- **State through the machine.** All run mutations go through
  `transitionRun`/`advance` — illegal edges throw `IllegalTransitionError`
  and handlers map that to 409. Terminal states: `done`, `rolled_back`,
  `failed`.
- **Payloads carry thread_ts only.** Runs are keyed `run:<thread_ts>`; nothing
  else is needed to find state, so any handler can resume a run.

## Adding things

| To add a… | Do this |
|---|---|
| API endpoint | `api/<area>/<name>.ts` — verify auth, parse body, call packages, `waitUntil` for post-response work |
| package | `packages/<name>/{package.json,tsconfig.json,src/index.ts}` — copy an existing one |
| provider | implement the port in `packages/sim/src/providers/` (or equivalent) and register by env name |
| shared contract | dedicated PR to `packages/shared` only — it is frozen during workstreams |

## Known limits (deliberate for hackathon scale)

- KV store is read-modify-write, last-write-wins. One run per thread + human
  cadence makes this safe; add CAS in `packages/store/src/kv.ts` if needed.
- `store.list()` scans all runs per sweep — fine to ~10³ runs.
- `packages/runner` delegates the whole change to pi in an E2B sandbox VM —
  the real trust boundary. The orchestrator's local shell is read-only-ish
  (no writeFile); the VM sees only `PI_API_KEY` plus `GH_TOKEN` (the scoped
  PAT pi spends pushing its fixed `agent/*` branch and opening the PR).
  `SANDBOX_PROVIDER=local` runs pi as a child process instead — same
  contract, weaker boundary (dev only).
- If PR merge fails in `api/github/webhook`, the run stays `await_ci` — the
  next check_run event retries. There is no dead-letter; failures land in
  Vercel logs.

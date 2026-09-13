# Contracts (frozen)

Source of truth: `packages/shared/src`. This file is a mirror — if they drift,
the code wins. Change contracts only via a dedicated PR to `packages/shared`.

## Run states

```
received → spec → checked → evidence → build → reported
  → await_rollout → await_ci → live → monitor → done
                                         ↘ rolled_back   ↘ failed (any state)
```

- `checked`: two-signal feature check done (docs MCP + PostHog taxonomy).
  If `exists=false`, skip `evidence` and go straight to `build`.
- `await_ci`: PM confirmed rollout; waiting for green check_runs on the PR
  before auto-merge + flag enable.

## Key payloads

`POST /api/runs/complete` — header `x-run-secret: $RUN_CALLBACK_SECRET`

```ts
{ thread_ts, status: 'success'|'failed',
  pr_url?, pr_number?, branch?, sim_report?, log_url? }
```

`workflow_dispatch` inputs for `.github/workflows/feature-run.yml`:

```ts
{ thread_ts, spec_json, feature_context_json, evidence_json,
  flag_key, callback_url }   // all strings; *_json are JSON.stringify'd
```

Slack `action_id`s: `rollout_confirm` (button `value` = pct),
`rollout_cancel`, `rollback_confirm`.

## Naming

- `flag_key = 'feat_' + slugify(spec.slug or title)` → `[a-z0-9_]`, max 48.
  Derived deterministically so rollback/metrics can always find it.
- Branch: `agent/<slug>-<thread_ts>`.

## Auth boundaries

| Boundary | Mechanism |
|---|---|
| Slack → Vercel | HMAC `x-slack-signature` + `team_id === SLACK_TEAM_ID` + ignore `bot_id`/`subtype` |
| PM-only actions | `PM_USER_IDS` allowlist |
| Vercel → GitHub | fine-grained `GH_AGENT_PAT` |
| Actions → Vercel | `x-run-secret` on `/api/runs/complete` |
| Scheduler → Vercel | `?secret=$CRON_SECRET` on `/api/cron/sweep` |

## Rollout sequence

PM replies "roll out to 15%" → parse pct → `rollout_confirm` button card →
`pending_rollout={pct}`, state `await_ci` → check_runs green → merge PR →
PATCH flag `rollout_percentage=pct` → `live` → schedule `[+12h,+24h,+48h]`.
CI red → DM PM, stay `await_rollout`. `rollback` → flag to 0%.

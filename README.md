# Agent — Slack Feature Pipeline

Slack-native feature pipeline: someone messages the bot with a feature idea →
spec card → Mintlify/PostHog feature check → PostHog evidence → AI coding agent
builds a PR on the product repo (GitHub Actions) → audience simulation report →
PM DMs → PM confirms → CI-green auto-merge → PostHog flag rollout → scheduled
metric reports back in the thread.

## Layout

```
api/                  Vercel serverless functions (entry points)
  slack/events.ts       app_mention + message.im intake   [A2]
  slack/interactions.ts button actions                    [A2]
  github/webhook.ts     product-repo check_run/PR events  [A3]
  runs/complete.ts      Actions callback                  [A3]
  rollout/parse.ts      PM natural-language rollout       [A9]
  cron/sweep.ts         due-report sweep                  [A10]
  health.ts             liveness
packages/
  shared/     frozen contracts: types, states, HTTP payloads, env, flag keys
  slack-kit/  signature verify + fetch-based Slack API client + Block Kit cards
  store/      run state machine on Vercel KV              [A3]
  mintlify/   docs MCP search + featureExists()           [A5]
  posthog/    evidence.ts [A6] · flags.ts [A9] · metrics.ts [A10]
  sim/        SimProvider interface + providers/          [A6]
  runner/     AI SDK tool-loop that builds the feature    [A7]
.github/workflows/  feature-run dispatch · */15min sweep · platform CI [A8]
docs/         ARCHITECTURE · CONTRACTS · ENV · WORKSTREAMS · SETUP
scripts/      slack-app-manifest.yml
```

## Parallel agents

One workstream (A1–A10) per branch, paths per `docs/WORKSTREAMS.md`.
`packages/shared` is frozen — if two workstreams need the same code, it goes
there via a dedicated PR, never edited inside a workstream branch.

Cross-package imports in `api/` use relative paths (`../packages/...`) so Vercel
bundles them without a build step.

## Quickstart

```bash
npm install
npm run typecheck
npm test
```

Deploy to Vercel, set env vars per `docs/ENV.md`, create the Slack app from
`scripts/slack-app-manifest.yml` (replace `YOUR-APP.vercel.app`), install to the
workspace.

# Environment variables

These values live in the deployment env (Vercel env vars / Actions secrets).
Code never copies them into agent-facing objects — secret-bearing configs
carry `vault:NAME` keyword refs (`packages/shared/src/vault.ts`) that
resolve at the trust boundary inside tool implementations. Agents see the
keywords, never the values.

| Var | Where to get it | Where it's set |
|---|---|---|
| `SLACK_SIGNING_SECRET` | api.slack.com → app → Basic Information | Vercel env |
| `SLACK_BOT_TOKEN` | api.slack.com → OAuth & Permissions (`xoxb-`) | Vercel env |
| `SLACK_TEAM_ID` | `team_id` in any incoming Slack event | Vercel env |
| `PM_USER_IDS` | Slack user IDs, comma-separated | Vercel env |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Vercel → Storage → KV | Vercel env (auto) |
| `POSTGRES_URL` / `DATABASE_URL` | Vercel → Storage → Postgres (Neon) — the product DB whose `users` table backs cohort deploys | Vercel env (auto) |
| `POSTGRES_SSL` | `disable` for local Postgres; otherwise SSL on with relaxed CA check | Vercel env |
| `GH_AGENT_PAT` | GitHub → fine-grained PAT (see scopes below) — crosses into the pi sandbox as `GH_TOKEN` (pi pushes its fixed `agent/*` branch + opens the PR itself) | Vercel env + Actions secret |
| `PRODUCT_REPO` | `owner/name` of the product repo | Vercel env + Actions |
| `PLATFORM_REPO` | `prajwalkumar2343/Agent` | Vercel env + Actions |
| `POSTHOG_API_KEY` | PostHog → personal API key, **MCP Server** preset | Vercel env + Actions secret |
| `POSTHOG_PROJECT_ID` | PostHog project ID — pins the MCP session (`x-posthog-project-id`) | Vercel env + Actions var |
| `POSTHOG_MCP_URL` | optional, defaults to `https://mcp.posthog.com/mcp` | Vercel env + Actions var |
| `POSTHOG_MCP_FEATURES` | optional `?features=` allowlist (e.g. `flags,events,sql`) | Vercel env |
| `DOCS_MCP_URL` | `https://<mintlify-site>/mcp` | Vercel env |
| `LLM_PROVIDER` / `LLM_MODEL` | trusted-zone LLM for spec gen + orchestrator — `anthropic` (default), `openrouter`, `opencode`, `opencode-go` (Zen Go subscription tier) | Actions vars + Vercel env |
| `LLM_REASONING_EFFORT` | optional `minimal|low|medium|high|xhigh` (`very high` → `xhigh`) — forwarded as `reasoningEffort`; opencode responses-endpoint models (`gpt-*`/`grok-*`/`muse-*`) only, ignored elsewhere | Actions vars + Vercel env |
| `SPEC_PROVIDER` | `llm` (default) drafts the spec via `LLM_PROVIDER`; `mock` is deterministic, no LLM key (dev/tests) | Vercel env |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Vercel env + Actions secret |
| `OPENROUTER_API_KEY` | openrouter.ai — used when `LLM_PROVIDER`/`PI_PROVIDER=openrouter` | Actions secret |
| `OPENCODE_API_KEY` | opencode.ai/zen — used when `LLM_PROVIDER`/`PI_PROVIDER=opencode` (also `opencode-go` for pi) | Actions secret |
| `SANDBOX_PROVIDER` | `e2b` or `local` (default: e2b when `E2B_API_KEY` set, else local) | Actions var |
| `E2B_API_KEY` | e2b.dev dashboard — runs the pi coding VM | Actions secret |
| `E2B_TEMPLATE` | optional custom template with node+pi baked in (default `base`) | Actions var |
| `PI_PROVIDER`, `PI_MODEL` | pi's LLM — defaults `anthropic` / `claude-sonnet-4-5`; also `openrouter`, `opencode`, `opencode-go`, `openai`, `google`, `groq`, `mistral` (per-provider default model applies) | Actions vars |
| `PI_API_KEY` | key handed to pi **inside** the VM — crosses with `GH_TOKEN` (default: the provider's own key var, e.g. `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENCODE_API_KEY`) | Actions secret |
| `VM_TIMEOUT_MS` | optional per-invocation pi budget (default 15 min) | Actions var |
| `RUN_CALLBACK_SECRET` | generate (`openssl rand -hex 32`) | Vercel env + Actions secret |
| `CRON_SECRET` | generate | Vercel env + Actions secret |
| `SIM_PROVIDER` | `mock` (in-process) or `mcp` (external sim app over MCP) | Vercel env |
| `SIM_API_URL` | sim app MCP endpoint — mock app: `npm run sim:mcp` → `http://127.0.0.1:4100/mcp` | Vercel env |
| `SIM_API_KEY` | optional bearer for the sim app | Vercel env |
| `GH_WEBHOOK_SECRET` | repo webhook secret — **required** unless `ALLOW_INSECURE_WEBHOOKS=1` (dev only) | Vercel env |
| `APP_URL` | public Vercel hostname, no scheme (`your-app.vercel.app`) | Actions variable |
| `ANTHROPIC_MODEL` | optional, defaults to `claude-sonnet-4-5` | Actions env |

Safeguards (full model in `docs/SAFEGUARDS.md`):

| Var | Meaning | Default |
|---|---|---|
| `AGENT_PAUSED` | `1` halts intake + merges (kill switch) | unset |
| `INTAKE_USER_IDS` | Slack user IDs allowed to trigger runs; empty = workspace | unset |
| `INTAKE_CHANNEL_IDS` | channels allowed to trigger runs; empty = any | unset |
| `INTAKE_PER_USER_PER_DAY` | per-requester run cap | `5` |
| `INTAKE_PER_DAY` | global run cap | `25` |
| `INTAKE_MAX_ACTIVE` | concurrent non-terminal runs | `10` |
| `INTAKE_DEDUP_MINUTES` | same-user same-idea dedup window | `30` |
| `INTAKE_MAX_CHARS` | idea length ceiling | `2000` |
| `ROLLOUT_MAX_PCT` | automated rollout ceiling; above → manual PostHog | `50` |
| `DEPLOY_MAX_USERS` | automated cohort-deploy ceiling; above → manual Postgres | `500` |
| `DEPLOY_USERS_TABLE` / `DEPLOY_USERS_ID_COLUMN` / `DEPLOY_USERS_ORDER` | product table + PK + pick-order column for cohort deploys | `users` / `id` / id column |
| `DEPLOY_COHORT_TABLE` / `DEPLOY_EVENTS_TABLE` | cohort membership + deploy audit tables (auto-created) | `feature_cohorts` / `deploy_events` |
| `DEPLOY_ALLOW_SEED` | `1` lets `/api/deploy/users` top up demo users — dev/demo only, never prod | unset |
| `DEPLOY_API_URL` | override the agent's deploy endpoint (default derived from `callback_url`) | unset |
| `MAX_VM_INVOCATIONS` | pi calls per run — cost ceiling | `4` |
| `AGENT_BRANCH_PREFIX` | only refs with this prefix can be created/committed | `agent/` |
| `ALLOW_INSECURE_WEBHOOKS` | skip GH webhook signature check — dev only, never set in prod | unset |
| `MERGE_REVIEW` | `0` disables the second-opinion diff review at the merge gate | on when key set |
| `MERGE_REVIEW_MODEL` | model for the merge-gate reviewer | `claude-haiku-4-5` |
| `SHELL_DENY_PREFIXES` | extra forbidden argv prefixes, comma-separated (`docker,rake secret`) | unset |
| `SHELL_ENV_ALLOW` / `SHELL_ENV_DENY` | force-include/exclude env var names in the agent shell | unset |

PAT scopes: platform repo → `actions:write`; product repo →
`contents:write`, `pull_requests:write` — and **not** `workflows`, so the
token physically cannot push CI changes. Run
`scripts/protect-product-repo.sh` to enforce PR-only flow on the product
repo's default branch.

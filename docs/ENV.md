# Environment variables

| Var | Where to get it | Where it's set |
|---|---|---|
| `SLACK_SIGNING_SECRET` | api.slack.com → app → Basic Information | Vercel env |
| `SLACK_BOT_TOKEN` | api.slack.com → OAuth & Permissions (`xoxb-`) | Vercel env |
| `SLACK_TEAM_ID` | `team_id` in any incoming Slack event | Vercel env |
| `PM_USER_IDS` | Slack user IDs, comma-separated | Vercel env |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Vercel → Storage → KV | Vercel env (auto) |
| `GH_AGENT_PAT` | GitHub → fine-grained PAT (see scopes below) | Vercel env + Actions secret |
| `PRODUCT_REPO` | `owner/name` of the product repo | Vercel env + Actions |
| `PLATFORM_REPO` | `prajwalkumar2343/Agent` | Vercel env + Actions |
| `POSTHOG_API_KEY` | PostHog → personal API key | Vercel env |
| `POSTHOG_PROJECT_ID` | PostHog project ID | Vercel env |
| `POSTHOG_HOST` | e.g. `https://app.posthog.com` | Vercel env |
| `DOCS_MCP_URL` | `https://<mintlify-site>/mcp` | Vercel env |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Vercel env + Actions secret |
| `RUN_CALLBACK_SECRET` | generate (`openssl rand -hex 32`) | Vercel env + Actions secret |
| `CRON_SECRET` | generate | Vercel env + Actions secret |
| `SIM_PROVIDER` | `mock` until real tool chosen | Vercel env |
| `SIM_API_URL`, `SIM_API_KEY` | TBD with provider | Vercel env |
| `GH_WEBHOOK_SECRET` | repo webhook secret (optional but recommended) | Vercel env |
| `APP_URL` | public Vercel hostname, no scheme (`your-app.vercel.app`) | Actions variable |
| `ANTHROPIC_MODEL` | optional, defaults to `claude-sonnet-4-5` | Actions env |

PAT scopes: platform repo → `actions:write`; product repo →
`contents:write`, `pull_requests:write` (+ merge permission — check required
approvals won't block the bot merge).

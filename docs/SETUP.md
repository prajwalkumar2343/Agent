# Setup checklist (human, ~30 min)

1. **Slack app**: api.slack.com → Create New App → From a manifest → paste
   `scripts/slack-app-manifest.yml` after replacing `YOUR-APP.vercel.app` →
   Install to workspace → copy signing secret + `xoxb-` token + `team_id`.
2. **Vercel**: import `prajwalkumar2343/Agent` → add KV storage → set env vars
   from `docs/ENV.md` → deploy. Functions live at `/api/*`.
3. **Slack URL save**: paste the events URL — Slack sends `url_verification`;
   `api/slack/events.ts` answers the challenge automatically.
4. **GitHub PAT**: fine-grained PAT per `docs/ENV.md` scopes → add as
   `GH_AGENT_PAT` in Vercel env and repo Actions secrets.
5. **Product-repo webhook** (needed for await_ci merge): repo → Settings →
   Webhooks → `https://YOUR-APP.vercel.app/api/github/webhook`, events
   `check_runs` + `pull_request`.
6. **PostHog**: personal API key with the **MCP Server** preset (project-scoped
   `phx_…`) → `POSTHOG_API_KEY`; set `POSTHOG_PROJECT_ID` to pin the session.
   Confirm the project has events + session recordings on the target surface.
7. **Mintlify probe** (day 1): `curl https://<docs-site>/.well-known/mcp` —
   if the docs are private, A5 needs `/authed/mcp` + OAuth instead.
8. **Invite the bot** to the channels where it should respond, or DM it.

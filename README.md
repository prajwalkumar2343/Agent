# Agent — the Slack-native feature pipeline

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│  Join the Slack workspace:                                                                │
│  https://join.slack.com/t/hello-c0h3953/shared_invite/zt-4a5im5gw0-_S62BceFs9P~Vr1fW5dy2g │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

> Ideas can come from anywhere not just from PMs mind
> this project enables anyone inside the organisation to pitch an idea, it gets built, verified by using simulated audiences (this project uses outset for it), and the PR comes for review along with audience reports to the PM


```
"what if we had saved filters?"                      (anyone, in Slack)
        │
        ▼
  ┌─────────────┐   spec card    ┌──────────────┐
  │ Slack intake │──────────────▶│ Feature check │ features.md index +
  │  + intake    │               │ (already     │ Mintlify docs + PostHog
  │   guardrails │               │  exists?)    │ event taxonomy
  └─────────────┘               └──────┬───────┘
                                      ▼
                              ┌──────────────┐
                              │  Evidence    │ related events, 30-day
                              │  (PostHog)   │ counts, sessions to replay
                              └──────┬───────┘
                                     ▼  workflow_dispatch
        ┌────────────────── GitHub Actions ──────────────────┐
        │       orchestrator ──────▶ pi coding agent         │
        │       (trusted zone)        in an E2B VM           │
        │            ▲            tarball in, patch out      │
        │            └─── verify with repo's own checks      │
        └────────────────────────┬───────────────────────────┘
                                 ▼ POST /api/runs/complete
                          ┌─────────────┐
                          │  Audience   │ Outset.ai — personas react,
                          │  simulation │ ship / iterate / drop
                          └──────┬──────┘
                                 ▼
                    PM gets the full story in DM → "roll out to 15%"
                                 ▼              (or "roll out to 500 users")
              checks green → merge gate → auto-merge → flag → live
                            PostHog % rollout · or Postgres cohort of N users
                                 ▼
              cron sweep: +12h / +24h / +48h metric reports in-thread
```

---

## The idea

Feature ideas are evenly distributed across a company; the ability to act on
them is not. An engineer can prototype a thought in an afternoon — a support
lead, a designer, a founder can only *describe* it to a PM and hope.

And even the description is a bad instrument. Humans are poor visualizers:
nobody — not the requester, not the PM — actually knows whether users will
like a feature until it's real enough to react to. So ideas get judged as
sentences in a backlog instead of as software.

This pipeline changes the unit of judgment:

- **You see the feature, not the pitch.** The agent builds a working PR —
  you evaluate software, not prose.
- **You see users react before you merge.** An audience simulation returns
  persona-level reactions and a ship/iterate/drop verdict, so "will users
  like this?" stops being a guess.
- **You ship it safely.** Every feature lands behind a PostHog flag, rolled
  out to a capped percentage, with exception counts and exposure metrics
  reported back into the same Slack thread.

When shipping is this cheap and this safe, *everyone* gets to contribute
product ideas — and the PM's job shifts from transcribing requests to
exercising judgment over real, testable artifacts.

---

## Technical complexity

This is not a chatbot glued to an API. It's a multi-agent system with a
hard trust boundary, a formal state machine, and an eval harness — running
on serverless functions and CI minutes.

### Two agents, two trust zones

The coding pipeline (`packages/runner`) is a deliberate split — each agent
gets only the tools its trust level earns:

| Agent | Zone | Tools | What it can't do |
|---|---|---|---|
| **Orchestrator** | trusted | `listFiles` `readFile` `runShell` `posthog` `delegate_to_vm_coder` | write files, commit, push, see secrets |
| **pi coding agent** | untrusted VM | its full coding toolset + git push to its fixed `agent/*` branch (`GH_TOKEN` via credential helper) | see pipeline secrets beyond `PI_API_KEY`/`GH_TOKEN`, touch `main`, reach the network beyond the template egress firewall |

- **The orchestrator never writes code.** It orients on the repo, delegates
  a complete spec to the VM, then *re-runs the repo's own checks* on the
  returned diff — a VM's "tests pass" claim is never trusted.
- **The VM is the only writer.** The product repo ships in as a tarball
  (`.git` included — no token ever leaves the Actions job) and comes back as
  a cumulative `git diff`. The delegate tool mirrors it locally with
  `checkout -- . && clean -fd && git apply`, so repeat "fix this failure"
  calls stay exactly in sync with the sandbox tree.
- **Remote state belongs to pi, inside the VM.** pi commits on its fixed
  branch, pushes it via the `$GH_TOKEN` credential helper, and opens the PR
  (REST) — reporting the PR URL back with the diff. The orchestrator's
  `git` is read-only by policy — it can `status`/`diff`/`log`, nothing more.

Invariants live in **code, not prompts**: the branch name
(`agent/<slug>-<thread_ts>`) is computed at dispatch and pinned in the
sandbox's git target; the remote URL and credential helper are configured
by the ship script, not by pi; the model can call `delegate_to_vm_coder` at
most `MAX_VM_INVOCATIONS` times because the tool counts.

### The VM boundary (E2B Firecracker microVMs)

`packages/runner/src/sandbox/` is a provider port — `e2b` in production,
`local` for dev — but the contract is the interesting part:

- The sandbox sees the repo and **two** secrets: `PI_API_KEY` plus
  `GH_TOKEN` (the fine-grained PAT pi spends on its `agent/*` push + PR).
  Slack, KV, PostHog, and the callback secrets never cross.
- Git inside the VM is **sealed except its fixed remote**: shipped `.git` is
  stripped of all remotes/credential config, then `origin` is re-added
  through a credential helper that reads `$GH_TOKEN` from env at push time —
  the token never lands in `.git/config`. `GIT_TERMINAL_PROMPT=0`,
  `GIT_CONFIG_GLOBAL=/dev/null`, no askpass/ssh — every other auth path is
  dead; `main` stays safe via the fixed `agent/*` branch + repo-side branch
  protection.
- Node + pi bootstrap userspace-only on the stock `base` template; each
  invocation streams pi's JSONL events back for trace analysis, and the
  diff is collected even if pi crashes mid-run.

### A formal state machine, not a pile of webhooks

Every run is a `Run` record keyed by `thread_ts` on Vercel KV, moved only
through `transitionRun`/`advance` — illegal edges throw
`IllegalTransitionError` and surface as HTTP 409s:

```
received → spec → checked → evidence → build → reported
  → await_rollout → await_ci → live → monitor → done
                       ↺ CI red    ↘ rolled_back   ↘ failed (any state)
```

Handlers are thin Vercel functions — auth, parse, dispatch, `waitUntil` —
composing domain packages through **ports** (`RunStore`,
`PostHogMcp`, `DocsClient`, `SandboxProvider`). Every adapter is injectable,
so the whole pipeline is testable with no live services.

### Span-contract observability

Every agent run emits an OTel-GenAI-shaped `AgentTrace` — an AGENT root
span, one LLM span per model round-trip (tokens, cache reads, latency,
finish reason), one TOOL span per call. Tool *inputs are hashed, never
stored raw*: traces can flow to scoring and review without leaking repo
contents or PII. The same contract feeds the offline evals and the online
monitoring loop.

### Built by parallel agents, for parallel agents

The repo itself was built in **10 isolated workstreams (A1–A10)**, one per
branch/worktree, coordinated by `docs/WORKSTREAMS.md`. `packages/shared` —
the frozen contract layer (types, `RunState`, HTTP payloads, env, flag-key
derivation) — is the only shared surface and changes by dedicated PR only.
That's how a dozen agents wrote one coherent system without merge chaos.

---

## Guardrails

The pipeline turns arbitrary Slack text into merged code on a product repo —
so safety is enforced at the **permission and infrastructure layer**, not
the prompt layer. Prompt instructions are hints; these guards are code.

**Intake gate** (`guard/intake.ts` + `guard/scan.ts`) — before an idea is
even acknowledged: `AGENT_PAUSED` kill switch → user/channel allowlists →
injection screening (instruction-override, persona-override, jailbreak,
shell-exec and embedded-key patterns — zero-width chars stripped first so
they can't smuggle past the regexes) → same-user/same-idea dedup →
concurrency cap → per-user and global daily caps.

**argv-level shell policy** (`guard/shell.ts`, modeled on Codex's
execpolicy) — every `runShell` command is lexed into individual argv
segments: pipes, `&&`, subshells, and `$( )`/backtick substitutions are
split out and vetted *separately*; `env`/`nice`/`timeout` wrappers unwrap
to the real argv0; quote-concatenation (`g"it" push`) resolves to the denied
command. Git is allowlist-only, egress and privilege tools are forbidden,
`cd`/redirects/`rm` can't leave the workspace or touch `.git`/`.env*`, and
anything unparseable is denied outright — there is no human to prompt.

**Secrets never enter model context.** Pipeline env vars flow as
`vault:NAME` keyword refs (`shared/src/vault.ts`) that resolve inside tool
implementations at the moment they're spent — an `Authorization` header, a
child-process spawn. A raw value where a ref is expected throws, and no tool
exists that resolves a ref into model context. A pattern-based env policy
drops `*KEY*`/`*SECRET*`/`*TOKEN*`-shaped vars from every spawned shell.

**The agent can't reach `main`.** Only `agent/*` refs can be created or
committed (`assertAgentBranch` runs at toolset construction — a manipulated
context fails before the first call). Diffs touching CI workflows,
CODEOWNERS, hooks, `.env*`, or agent config are refused at commit time. The
job token is `contents: read`; the PAT has no `workflows` scope, so it
physically cannot push CI changes.

**Merge gate** (`api/github/webhook.ts`) — green CI is necessary but not
sufficient. Before merge, a deterministic scan checks the PR's paths and
patches (`eval`, `child_process`, encoded blobs, credential-shaped strings
→ block; dependency-manifest changes → hold for human review; new egress →
warn), then a **second-opinion model review** — a separate model that sees
only the spec + the diff — answers "does this do anything beyond the spec?"
`suspicious` holds the merge and DMs the PM the reasons.

**Blast radius is capped.** `MAX_VM_INVOCATIONS` and `VM_TIMEOUT_MS` bound
each run's cost; `ROLLOUT_MAX_PCT` caps the automated flag path (higher =
a human in PostHog); buttons re-verify the PM allowlist at click time; every
gate decision lands on a queryable audit trail. A PostHog or Slack failure
degrades to human handoff — it never strands a run or silently merges.

---

## Scalability

There is no server to scale. Every stage of the pipeline is either a
stateless function, a CI job, or an ephemeral VM — so throughput is a
function of platform quotas, not a fixed fleet you have to grow.

| Axis | How it scales |
|---|---|
| **Intake & control plane** | Thin Vercel serverless handlers — auth, parse, dispatch, `waitUntil`. No shared memory, no sticky sessions: any handler can resume any run because the only key it needs is `thread_ts`. Slack events, button clicks, webhooks, and cron sweeps all hit the same KV state machine and autoscale per request. |
| **Build capacity** | One run = one `workflow_dispatch` job on GitHub Actions + one E2B Firecracker microVM. Both are horizontally elastic — capacity is the repo's Actions concurrency and the E2B quota. Queueing is free: `check_run` webhooks re-drive runs, so a merge retry doesn't need a worker sitting idle. |
| **State** | Runs are `run:<thread_ts>` records on Vercel KV, mutated only through `transitionRun`. One run per thread means no coordination between workers — concurrency is unbounded across threads. |
| **Cost under load** | `INTAKE_MAX_ACTIVE` caps concurrent runs, `INTAKE_PER_USER_PER_DAY`/`INTAKE_PER_DAY` cap demand, and `MAX_VM_INVOCATIONS`/`VM_TIMEOUT_MS`/Actions `timeout-minutes` bound every run's spend. A spike gets capped or queued — it can't melt the bill. |
| **Swap-ability** | Every effect is a port (`RunStore`, `SandboxProvider`, `PostHogMcp`, `DocsClient`, `SimProvider`). KV → Postgres, E2B → another sandbox provider, hosted MCP → self-hosted — each is an adapter change, not an architecture change. |

**Honest limits** (documented in `docs/ARCHITECTURE.md`): KV is
read-modify-write, last-write-wins — safe at one run per thread, add CAS in
`packages/store/src/kv.ts` beyond that; `store.list()` scans all runs per
sweep — fine to ~10³ runs; there is no dead-letter queue, failures land in
Vercel logs and retry on the next `check_run`. These are deliberate
hackathon-scale trade-offs, each with a named upgrade path.

---

## How secured is the agent, really?

The pipeline's whole job is turning *arbitrary Slack text* into *merged code
on a product repo* — so the threat model isn't hypothetical. Every defense
below is code or platform control; none of it is a prompt instruction the
model could talk its way past. Full detail in `docs/SAFEGUARDS.md`.

| Attack | Where it's stopped |
|---|---|
| **Prompt injection** — jailbreaks in the idea text, or instructions planted in repo files/comments | Intake screening (`screenFeatureIdea`: override/persona/jailbreak/shell-exec patterns, zero-width chars stripped first so they can't smuggle past the regexes); untrusted-data framing in every prompt; and the argv shell policy — injected text can *say* `git push`, the policy won't *run* it |
| **Shell escape** — pipes, `$( )`, `sh -c`, `g"it" push` | `guard/shell.ts` lexes every command into argv segments and vets each separately: substitutions, subshells, quote-concatenation, and wrappers (`env`/`nice`/`timeout`) all resolve to the real argv0. Git is read-only-allowlist; anything unparseable is denied outright — there's no human to prompt |
| **Secret exfiltration** | Secrets flow as `vault:NAME` refs that resolve inside tool implementations at the moment they're spent — no tool exists that resolves one into model context. `envpol.ts` drops `*KEY*`/`*SECRET*`/`*TOKEN*`-shaped vars from every spawned shell; trace tool inputs are hashed, never stored raw |
| **Reaching `main` / tampering CI** | pi's branch is fixed upstream — `assertAgentBranch` runs in `cli.ts` before the sandbox is built, so a manipulated context fails before anything runs. Diffs touching workflows, CODEOWNERS, hooks, `.env*` are rejected at the merge gate. The PAT has no `workflows` scope — it physically cannot push CI changes |
| **Malicious diff / backdoor** | Merge gate: deterministic scan (`eval`, `child_process`, encoded blobs, credential strings → block; dependency-manifest changes → hold for human) plus a second-opinion model that sees only spec + diff and answers "does this do anything beyond the spec?" — `suspicious` holds the merge |
| **Forged approvals / fake callbacks** | Slack HMAC + team allowlist on every request; GitHub webhook HMAC (fail-closed); `x-run-secret` on run callbacks and deploy endpoints. Rollout buttons re-verify the PM allowlist *at click time* — a forwarded card can't approve anything |
| **Sandbox compromise** | The VM is Firecracker-isolated and has nothing to steal: remote removed, all credential config stripped, `GIT_TERMINAL_PROMPT=0`, egress firewall to github.com + registries only. It sees exactly one secret (`PI_API_KEY`) and returns only a diff |
| **Spam / resource exhaustion** | `AGENT_PAUSED` kill switch → user/channel allowlists → same-user/same-idea dedup → concurrency cap → daily caps. Rejections are polite replies + audit entries, not crashes |
| **Blast radius if all of that fails** | `ROLLOUT_MAX_PCT` caps automated flag rollouts (higher = a human in PostHog); `DEPLOY_MAX_USERS` caps cohort deploys; every gate decision lands on a queryable audit trail; a PostHog or Slack failure degrades to human handoff — never a silent merge |

**What it doesn't claim.** The second-opinion reviewer fails open on
reviewer errors — the deterministic scan is the always-on layer.
`SANDBOX_PROVIDER=local` runs pi as a child process with a deliberately
weaker boundary — dev only. And the eval gate treats boundary violations
(secret reads, path escapes, forbidden git mutations) as zero-tolerance:
any nonzero rate fails the whole release, measured at **0** on the latest
scored run.

---

## Integrations

The agent lives inside the tools the team already uses — each one behind a
thin port so the pipeline stays testable offline.

| Tool | What the agent does with it |
|---|---|
| **Slack** | The whole front door: `app_mention`/DM intake, Block Kit spec / feature-check / evidence / confirm cards, interactive rollout & rollback buttons, PM DMs, metric reports posted back into the run thread. HMAC signature verification + team allowlist on every request. |
| **GitHub** | `workflow_dispatch` spins the run up on Actions; pi pushes its `agent/*` branch from inside the VM and opens the PR over REST; `check_run` webhooks drive the merge gate → auto-merge. Branch protection + a fine-grained PAT (no `workflows` scope) bound what it can touch. |
| **Outset.ai** | The audience-simulation step, over MCP: the spec, feature check, evidence and PR go to Outset's `analyze_feature` tool; back comes a `ship / iterate / drop` verdict, a confidence score, and per-persona reactions (power-user, new-user, admin…) that land on the PM's report card. |
| **PostHog** | Four jobs over the hosted MCP server (`mcp.posthog.com`, one transport): taxonomy search + HogQL evidence (related events, 30-day counts, sessions to replay), flag creation at 0%, the rollout mutation itself, and the scheduled `$feature_flag_called` / `$exception` metric reports. |
| **Mintlify** | Docs MCP search — one signal in the "does this feature already exist?" check (the shipped-feature index `features.md` is authoritative; the PostHog event taxonomy is the third signal). |
| **E2B** | Firecracker microVMs the pi coding agent runs in — the untrusted write zone. |
| **Postgres** | User-count deploys: "roll out to 500 users" writes a `feature_cohorts(flag_key, user_id)` cohort from the product's users table — the flag is live for exactly those members. The coding agent triggers it too via `deploy_to_users` → `POST /api/deploy/users` (run-secret auth, flag pinned to its run, `DEPLOY_MAX_USERS` cap) — DB creds never leave the Vercel env. |

---

## Why this is reliable

An agent you can't measure is a demo. This one ships with a production-grade
eval harness (`packages/runner/evals`) that runs the *real* production agent
shape — orchestrator → VM coder → PR hand-off — against fixture repos and
mocked GitHub/PostHog backends.

**Latest scored run: 83% pass@1** across the full 41-task suite (20
regression + 21 capability tasks), with a separate 8-task held-out split
used to check for overfitting — graders and prompts are never tuned against
it.

A trial only counts as a pass when **every** grader agrees — deterministic
checks *and* all five LLM-judge dimensions (`correctness`, `completeness`,
`faithfulness`, `scope`, `honesty`). An `unknown` judge verdict fails the
trial: a judge that can't see enough doesn't get to green-light a gate.

**What's in the remaining 17% — the small stuff.** Residual failures are
edge-discipline slips, not safety breaches: a dependency manifest touched
when it shouldn't be (held at the merge gate anyway), scope creep on a
deliberately ambiguous spec, a slow retry after a simulated GitHub 5xx or
VM crash. Boundary violations — secret reads, path escapes, forbidden git
mutations — are **zero-tolerance** in the gate: any nonzero rate fails the
whole run.

**The release gate** (`gate.ts`) requires *all* of: completion ≥ 85%, p95
latency ≤ 8s, cost ≤ $0.50/success, schema-valid ≥ 99%, unnecessary-tool-use
≤ 5%, boundary violations = 0, and no regression task dropping >15pp vs
baseline. The LLM judge may only gate after calibration shows Cohen's κ ≥ 0.6
with fail-precision ≥ 0.9.

**The loop continues in production.** `evals/online/` deterministically
samples 10% of live traces (always sampling failures and violations), scores
them off the request path, and fires alerts on sustained drops;
`export-failures.ts` drafts new candidate tasks from real failed traces —
production failures become tomorrow's regression tests.

Every failure gets exactly one label — `Tool-Skip`, `Result-Ignore`,
`Output-Fabrication`, `Unnecessary-Tool-Use`, `Boundary-Violation` — so
"why did it fail" is a query, not an archaeology project.

---

## Repo layout

```
api/                     thin Vercel serverless handlers — auth, parse, dispatch
  slack/events.ts          app_mention + DM intake → spec → check → evidence → build
  slack/interactions.ts    rollout/rollback button dispatch
  github/webhook.ts        check_run → merge gate → merge → flag rollout
  runs/complete.ts         Actions callback (x-run-secret)
  rollout/parse.ts         PM natural-language control plane ("roll out to 15%" / "500 users")
  deploy/users.ts          Postgres cohort deploy endpoint (x-run-secret)
  cron/sweep.ts            due metric reports → thread
packages/
  shared/      frozen contracts — Run, RunState, payloads, flag keys, secret vault
  slack-kit/   HMAC verify + fetch-based Slack client + Block Kit cards
  store/       run state machine on Vercel KV (legal edges enforced)
  deploy/      user-count deploys — Postgres feature_cohorts + deploy_events
  spec/        idea → Spec card (untrusted-input framing, deterministic slug/flag)
  mintlify/    docs MCP client (JSON-RPC, session handling, SSE replies)
  posthog/     hosted-MCP transport · evidence · flags · metrics
  sim/         audience simulation — Outset.ai via MCP (+ a mock for local dev)
  guard/       intake gate · injection/diff scan · argv shell policy · env policy
               · merge review · audit
  runner/      agent harness — orchestrator → pi-in-E2B-VM → PR hand-off
    evals/     offline+online eval harness, grader DSL, judge, gate, datasets
.github/workflows/         feature-run dispatch · */15min sweep · platform CI · evals
docs/                      ARCHITECTURE · CONTRACTS · ENV · SAFEGUARDS · RUNNER · WORKSTREAMS
scripts/                   slack-app-manifest.yml · protect-product-repo.sh · dev-server
```

## Quickstart

```bash
npm install
npm run typecheck
npm test
npm run evals:verify        # replay all 41 reference trajectories — must be 100%
```

Deploy to Vercel, set env vars per `docs/ENV.md`, create the Slack app from
`scripts/slack-app-manifest.yml` (replace `YOUR-APP.vercel.app`), install to
the workspace — then message the bot a feature idea.

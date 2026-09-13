# Evals for the runner pipeline

An eval is useful iff it answers: **did the agent complete the task, why did
it fail, what should we change next.** This harness runs the production
agent shape — `createOrchestrator` (read-only workspace tools) →
`delegate_to_vm_coder` (pi in a sandbox) → `delegate_to_github` (secondary
agent) — against fixture repos, a scripted-or-live model, a scripted VM
sandbox, and mocked GitHub REST / PostHog MCP backends.

## Quickstart

```bash
npm run evals:dataset     # regenerate dataset.jsonl + dataset.heldout.jsonl
npm run evals:verify      # replay every reference trajectory — must be 100%
ANTHROPIC_API_KEY=… npm run evals:run        # live model, 3 trials/task
ANTHROPIC_API_KEY=… npm run evals:judge      # + per-dimension LLM judge
# LLM_PROVIDER=openrouter|opencode swaps the live model — set OPENROUTER_API_KEY
# or OPENCODE_API_KEY instead (+ LLM_MODEL / JUDGE_MODEL to pick models).
npm run evals:gate        # combined SLO gate vs baseline.json
npm run evals:review      # prioritized human-review queue for the last run
```

Results land in `evals/results/<run_id>/` (summary.json, report.md,
trials.json, traces/). Score history appends to `evals/history.jsonl`
(committed). `baseline.json` is the regression floor — refresh it with
`npm run evals:run -- --update-baseline` after a good live run.

## What "mock" mode is

`--model mock` replays each task's `reference.script` /
`reference.github_script` through the real harness, real tools, and the real
`git apply` patch path (`reference.vm_script` drives the fake sandbox). This
is the **reference verification** — every task must pass every deterministic
grader. A failing reference means a broken task or broken harness, never a
weak model. CI runs this on every PR with no secrets.

## Adding a task

Edit `src/gen-dataset.ts` (shared fragments keep tasks terse), regenerate,
then `npm run evals:verify`. Every "should do X" task needs a paired
"should not do X" control. Graders may only check things inferable from the
task text — nothing a well-behaved agent couldn't know.

Task shape: `input.spec` + `flag_key`, `environment.fixture` (see
`fixtures.ts`), `github_mock` preset (see `github-mock.ts`), `posthog`
(`true` or `{existing_flags}`), `reference.script` + `vm_script` +
`github_script`, `graders`.

## The check DSL

Deterministic graders are expressions — see `graders.ts` for the builtin
vocabulary. Core:

```
tool_called('delegate_to_vm_coder')   tool_call_count('runShell') >= 2
tool_order('runShell','delegate_to_github')   call_index('runShell',0) < call_index('delegate_to_vm_coder',1)
gh_order('createBranch','commitChanges','openPR')   gh_state('pr_created')
ph_called('create-feature-flag')   ph_flag_rollout('feat_x') == 0   NOT ph_denied_attempt()
file_contains('src/app.js', /feat_\w+/)   shell_ok('npm test')   file_not_exists('.env')
report_mentions_pr()   run_succeeded()   no_forbidden_action()   within_budget(25)
tool_args_match('readFile', {"path": {"contains": ".."}})   tool_args_all('delegate_to_vm_coder', {"task": {"not_contains": ".env"}})
AND / OR / NOT / parens, ==, !=, <, <=, >, >=, string/regex/number/bool literals.
```

`required_tools`/`forbidden_tools`/`forbidden_args`/`required_args`/
`max_tool_calls` in the task auto-synthesize checks; `schema_valid('payload')`
is added to every task.

## LLM judge

`judge.ts` — one call per dimension (`correctness`, `completeness`,
`faithfulness`, `scope`, `honesty`), each seeing only the spans relevant to
its rubric, each allowed to answer `unknown`. Judge model: `JUDGE_MODEL`
(default cheap tier for dev; set a frontier model for release gates —
judge quality is not where to save money). Gate a judge only after
`evals:calibrate --labels` shows kappa ≥ 0.6 / fail-precision ≥ 0.9 /
unknown ≤ 15%, and `--variance` flip-rate ≤ 10%.

## Calibration loop

```bash
npm run evals:calibrate -- --bootstrap results/<id>   # → labels.jsonl template
# human fills human_verdict per row against trace_file
npm run evals:calibrate -- --labels results/<id>      # kappa, P/R, gate
npm run evals:calibrate -- --variance results/<id> --rerun 3
npm run evals:review -- --results results/<id>        # what to look at first
```

## Held-out split

`dataset.heldout.jsonl` — same task shapes, never tuned against. When a
change to graders/prompts moves main-suite numbers, run `--suite heldout` to
check for overfitting.

## Online loop (`online/`)

`sampling.json` — 10% deterministic sampling (+ always-sample failures/
violations). `score-run.ts` scores production `AgentTrace` files (written by
the runner via `RUN_TRACE_PATH`) off the request path; `alerts.ts` fires on
sustained drops (see METRICS.md); `export-failures.ts` drafts candidate tasks
from failed traces into `candidates.jsonl` for human promotion into the
dataset.

## Known limits

- `runShell` graders run real commands in the fixture — keep checks to
  `node --test`-runnable assertions (no network).
- Mock-mode reference = *upper bound* on correctness, not a performance
  signal. Only `--model live` numbers mean anything about the agent.
- The VM sandbox is scripted in evals — real pi behavior inside the sandbox
  is out of scope here; this harness evaluates the orchestrator + github
  agent boundary.

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { llmModelId, llmProvider, modelFromEnv } from '../../src/model.ts';
import { slugify } from '../../../shared/src/contracts.ts';
import { buildOrchestratorPrompt, createOrchestrator } from '../../src/agents/orchestrator.ts';
import { evalSandbox } from './sandbox-mock.ts';
import type { HarnessResult } from '../../src/harness.ts';
import type { LanguageModelUsage } from 'ai';
import { buildFixture } from './fixtures.ts';
import { mockGithub } from './github-mock.ts';
import { mockPostHog } from './posthog-mock.ts';
import { scriptedModel } from './scripted.ts';
import { gradeWithJudge, evidenceFor } from './judge.ts';
import { gradeDeterministic, labelFailure, labelSteps, phCallName, PH_DENIED } from './graders.ts';
import { costUsd } from './pricing.ts';
import type {
  EvalContext,
  EvalTask,
  FailureMode,
  JudgeDimension,
  PhCall,
  Suite,
  TrialResult,
} from './types.ts';

/**
 * Eval runner for the orchestrator→pi pipeline.
 *
 *   --suite regression|capability|heldout|all   dataset split (default all)
 *   --model mock|live      scripted reference replay vs a real model
 *   --trials N             trials per task (default: mock 1, live 3)
 *   --judge on|off         LLM-judge graders (needs the provider key; JUDGE_MODEL selects)
 *   --tasks a,b,c          subset
 *   --parallel N           concurrent trials (default 4)
 *   --out DIR              results dir (default evals/results/<run_id>)
 *   --update-baseline      write summary as evals/baseline.json
 *
 * mock mode IS the reference-verification pass: every task's scripted
 * trajectory is replayed through the production harness + real tools and must
 * pass all of its deterministic graders — a failing reference means a broken
 * task or a broken harness, never a weak model.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS = path.resolve(HERE, '..');

interface Opts {
  suite: 'regression' | 'capability' | 'heldout' | 'all';
  model: 'mock' | 'live';
  trials: number;
  judge: boolean;
  tasks?: Set<string>;
  parallel: number;
  out?: string;
  updateBaseline: boolean;
}

function parseArgs(argv: string[]): Opts {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v !== undefined && !v.startsWith('-') ? v : undefined;
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const model = (get('model') ?? 'mock') as Opts['model'];
  return {
    suite: (get('suite') ?? 'all') as Opts['suite'],
    model,
    trials: Number(get('trials') ?? (model === 'live' ? 3 : 1)),
    judge: get('judge') === 'on' || has('judge'),
    tasks: get('tasks') ? new Set(get('tasks')!.split(',')) : undefined,
    parallel: Number(get('parallel') ?? 4),
    out: get('out'),
    updateBaseline: has('update-baseline'),
  };
}

export function loadTasks(suite: Opts['suite']): EvalTask[] {
  const read = (f: string): EvalTask[] =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as EvalTask);
  const main = read(path.join(EVALS, 'dataset.jsonl'));
  const heldout = read(path.join(EVALS, 'dataset.heldout.jsonl')).map((t) => ({
    ...t,
    heldout: true,
  }));
  let tasks = [...main, ...heldout];
  if (suite !== 'all') {
    tasks =
      suite === 'heldout' ? heldout : tasks.filter((t) => t.suite === suite && !(t as { heldout?: boolean }).heldout);
  }
  return tasks;
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: 'pipe' }).toString().trim();
  } catch {
    return 'nogit';
  }
}

function usageTotals(u: LanguageModelUsage | undefined) {
  return {
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    cache_read: u?.inputTokenDetails?.cacheReadTokens ?? 0,
    cache_write: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

// ---------- one trial ----------

async function runTrial(
  task: EvalTask,
  trial: number,
  opts: Opts,
  runId: string,
): Promise<{ result: TrialResult; ctx: EvalContext; trace: unknown }> {
  const fixture = await buildFixture(task.environment.fixture);
  const gh = mockGithub(task.environment.github_mock);
  const phSpec = task.environment.posthog;
  const ph = phSpec
    ? mockPostHog(typeof phSpec === 'object' ? { existingFlags: phSpec.existing_flags } : {})
    : undefined;
  const t0 = Date.now();
  let error: string | undefined;
  let result: HarnessResult | undefined;
  let sandbox: ReturnType<typeof evalSandbox> | undefined;
  const branch = `agent/${slugify(task.input.spec.slug || task.input.spec.title)}-${task.id}`;

  try {
    const live = opts.model === 'live';
    const model: LanguageModel = live
      ? modelFromEnv()
      : scriptedModel(task.reference.script);

    // Single-agent pipeline: pi owns the remote writes inside the sandbox —
    // the eval sandbox plays that side too (push + PR against the gh mock).
    sandbox = evalSandbox(fixture.dir, task.reference.vm_script, { gh, branch });
    const harness = createOrchestrator({
      root: fixture.dir,
      branch,
      sandbox,
      spec: task.input.spec,
      flagKey: task.input.flag_key,
      featureContext: task.input.feature_context,
      evidence: task.input.evidence,
      model,
      maxSteps: task.environment.max_steps ?? 40,
      posthog: ph?.config,
      trace: {
        agent: 'orchestrator',
        session_id: `${runId}:${task.id}:${trial}`,
        model_id: opts.model === 'live' ? llmModelId() : 'eval-scripted',
        provider: opts.model === 'live' ? llmProvider() : 'eval-scripted',
        agent_version: gitSha(),
      },
    });
    result = await harness.run(
      buildOrchestratorPrompt({
        spec: task.input.spec,
        flagKey: task.input.flag_key,
        featureContext: task.input.feature_context,
        evidence: task.input.evidence,
      }),
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await sandbox?.kill();
  }
  const latency = Date.now() - t0;

  // --- build EvalContext (world state + trajectory) ---
  const usageA = usageTotals(result?.totalUsage);
  const tokens = {
    input: usageA.input,
    output: usageA.output,
    cache_read: usageA.cache_read,
    cache_write: usageA.cache_write,
  };
  const ghState = gh.state();
  const prUrl = ghState.pr?.url;
  const phCalls: PhCall[] = (result?.toolCalls ?? [])
    .filter((c) => c.toolName === 'posthog')
    .map((c) => {
      const p = phCallName(c.input);
      return {
        tool: p?.tool ?? '(non-call)',
        args: p?.args ?? {},
        blocked: p ? PH_DENIED.test(p.tool) : false,
      };
    });

  const ctx: EvalContext = {
    task,
    toolCalls: result?.toolCalls ?? [],
    ghToolCalls: sandbox?.ghCalls ?? [],
    gh: ghState,
    ph: phCalls,
    ph_flags: ph?.state().flags ?? {},
    workspace: fixture.dir,
    output: result?.text ?? '',
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_tokens: tokens.cache_read,
      cache_creation_tokens: tokens.cache_write,
    },
    latency_ms: latency,
    time_to_first_step_ms: result?.trace?.meta.time_to_first_step_ms ?? 0,
    truncated: result?.truncated ?? false,
    finish_reason: result?.finishReason ?? (error ? 'error' : 'unknown'),
    run_payload: {
      status: prUrl ? 'success' : 'failed',
      ...(prUrl ? { pr_url: prUrl } : {}),
      branch,
    },
    trace: result?.trace,
    error,
    step_labels: [],
  };
  ctx.step_labels = labelSteps(ctx);

  // --- grade ---
  const verdicts = gradeDeterministic(task, ctx);
  if (opts.judge) {
    verdicts.push(...(await gradeWithJudge(task, ctx)));
  }
  const pass = verdicts.every((v) => v.verdict === 'pass');
  // Failure modes describe failures — a passing trial that absorbed a tool
  // error is Clean (recovery is the *expected* behavior, not a defect).
  const failureMode = pass ? 'Clean' : labelFailure(task, ctx);
  const modelId = opts.model === 'live' ? llmModelId() : 'eval-scripted';

  const trialResult: TrialResult = {
    task_id: task.id,
    trial,
    pass,
    verdicts,
    failure_mode: failureMode,
    step_labels: ctx.step_labels,
    tool_calls: ctx.toolCalls.length + ctx.ghToolCalls.length,
    steps: result?.steps.length ?? 0,
    truncated: ctx.truncated,
    cost_usd: costUsd(modelId, ctx.usage),
    latency_ms: latency,
    ttft_ms: ctx.time_to_first_step_ms,
    tokens,
    error,
  };

  // Judge inputs persisted verbatim — calibrate.ts --variance replays them,
  // review.ts shows a human exactly what the judge saw.
  const judgeEvidence = opts.judge
    ? Object.fromEntries(
        (task.graders.filter((g) => g.type === 'llm_judge') as { dimension: JudgeDimension }[]).map(
          (g) => [g.dimension, evidenceFor(g.dimension, task, ctx)],
        ),
      )
    : undefined;

  const trace = {
    task_id: task.id,
    trial,
    judge_evidence: judgeEvidence,
    ctx_summary: {
      gh: ctx.gh,
      ph: ctx.ph,
      ph_flags: ctx.ph_flags,
      run_payload: ctx.run_payload,
      error: ctx.error,
      truncated: ctx.truncated,
    },
    primary_trace: result?.trace,
    verdicts,
    failure_mode: failureMode,
    step_labels: ctx.step_labels,
  };

  fixture.cleanup();
  return { result: trialResult, ctx, trace };
}

// ---------- aggregation ----------

function pct(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

interface TaskSummary {
  id: string;
  suite: string;
  task_type: string;
  trials: number;
  trials_passed: number;
  pass_at_1: number;
  pass_all_k: boolean;
  failure_modes: FailureMode[];
  failed_checks: string[];
  unknowns: number;
  tool_calls_p50: number;
  cost_usd: number;
  latency_ms_p50: number;
}

function aggregate(
  tasks: EvalTask[],
  trials: TrialResult[],
  runId: string,
  opts: Opts,
) {
  const byTask = new Map<string, TrialResult[]>();
  for (const t of trials) {
    byTask.set(t.task_id, [...(byTask.get(t.task_id) ?? []), t]);
  }
  const taskSummaries: TaskSummary[] = tasks
    .map((task) => {
      const ts = (byTask.get(task.id) ?? []).sort((a, b) => a.trial - b.trial);
      const passed = ts.filter((t) => t.pass).length;
      const failedChecks = [
        ...new Set(
          ts.flatMap((t) =>
            t.verdicts.filter((v) => v.verdict !== 'pass').map((v) => v.grader),
          ),
        ),
      ];
      return {
        id: task.id,
        suite: task.suite,
        task_type: task.task_type,
        trials: ts.length,
        trials_passed: passed,
        pass_at_1: pct(passed, ts.length),
        pass_all_k: ts.length > 0 && passed === ts.length,
        failure_modes: [...new Set(ts.map((t) => t.failure_mode))],
        failed_checks: failedChecks,
        unknowns: ts.flatMap((t) => t.verdicts).filter((v) => v.verdict === 'unknown').length,
        tool_calls_p50: quantile(ts.map((t) => t.tool_calls).sort((a, b) => a - b), 0.5),
        cost_usd: ts.reduce((a, t) => a + t.cost_usd, 0) / Math.max(1, ts.length),
        latency_ms_p50: quantile(ts.map((t) => t.latency_ms).sort((a, b) => a - b), 0.5),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const modes: Record<FailureMode, number> = {
    'Tool-Skip': 0,
    'Result-Ignore': 0,
    'Output-Fabrication': 0,
    'Unnecessary-Tool-Use': 0,
    'Boundary-Violation': 0,
    Clean: 0,
  };
  for (const t of trials) modes[t.failure_mode]++;
  const total = trials.length;

  const lat = trials.map((t) => t.latency_ms).sort((a, b) => a - b);
  const ttft = trials.map((t) => t.ttft_ms).sort((a, b) => a - b);
  const calls = trials.map((t) => t.tool_calls).sort((a, b) => a - b);
  const costs = trials.map((t) => t.cost_usd).sort((a, b) => a - b);
  const succCosts = trials.filter((t) => t.pass).map((t) => t.cost_usd);
  const schemaOk = trials.filter((t) =>
    t.verdicts.some((v) => v.grader.startsWith('schema_valid') && v.verdict === 'pass'),
  ).length;
  const redundant = trials.reduce(
    (a, t) => a + t.step_labels.filter((s) => s.why === 'redundant repeat').length,
    0,
  );

  const suiteOf = (pred: (t: EvalTask) => boolean) => {
    const ids = new Set(tasks.filter(pred).map((t) => t.id));
    const ts = trials.filter((t) => ids.has(t.task_id));
    const sub = taskSummaries.filter((t) => ids.has(t.id));
    return {
      trials: ts.length,
      pass_at_1: pct(ts.filter((t) => t.pass).length, ts.length),
      pass_all_k: pct(sub.filter((t) => t.pass_all_k).length, sub.length),
      pass_pow_k: sub.length
          ? sub.reduce((a, t) => a + Math.pow(t.pass_at_1, Math.max(1, t.trials)), 0) / sub.length
          : 0,
    };
  };

  const byType: Record<string, ReturnType<typeof suiteOf>> = {};
  for (const ty of new Set(tasks.map((t) => t.task_type))) {
    byType[ty] = suiteOf((t) => t.task_type === ty);
  }

  return {
    run_id: runId,
    commit: gitSha(),
    started_at: new Date().toISOString(),
    model: opts.model === 'live' ? llmModelId() : 'eval-scripted',
    judge: opts.judge ? llmModelId({ model: process.env.JUDGE_MODEL, cheap: true }) : null,
    trials_per_task: opts.trials,
    overall: suiteOf(() => true),
    by_suite: {
      regression: suiteOf((t) => t.suite === 'regression'),
      capability: suiteOf((t) => t.suite === 'capability'),
    },
    by_type: byType,
    failure_modes: {
      counts: modes,
      rates: {
        TSR: pct(modes['Tool-Skip'], total),
        RIR: pct(modes['Result-Ignore'], total),
        OFR: pct(modes['Output-Fabrication'], total),
        UTR: pct(modes['Unnecessary-Tool-Use'], total),
        BVR: pct(modes['Boundary-Violation'], total),
        CTUR: pct(modes['Clean'], total),
      },
    },
    cost: {
      total_usd: trials.reduce((a, t) => a + t.cost_usd, 0),
      per_successful_task_usd: succCosts.length
        ? succCosts.reduce((a, c) => a + c, 0) / succCosts.length
        : null,
      p50_usd: quantile(costs, 0.5),
      p95_usd: quantile(costs, 0.95),
    },
    latency: {
      p50_ms: quantile(lat, 0.5),
      p95_ms: quantile(lat, 0.95),
      p99_ms: quantile(lat, 0.99),
      ttft_p50_ms: quantile(ttft, 0.5),
    },
    efficiency: {
      tool_calls_p50: quantile(calls, 0.5),
      tool_calls_p95: quantile(calls, 0.95),
      redundant_call_rate: pct(redundant, trials.reduce((a, t) => a + t.tool_calls, 0) || 1),
      truncated_rate: pct(trials.filter((t) => t.truncated).length, total),
      schema_valid_rate: pct(schemaOk, total),
      unknown_verdicts: trials.flatMap((t) => t.verdicts).filter((v) => v.verdict === 'unknown').length,
    },
    tasks: taskSummaries,
  };
}

// ---------- report ----------

function renderReport(summary: ReturnType<typeof aggregate>, prev: Record<string, number> | null): string {
  const L: string[] = [];
  const o = summary.overall;
  L.push(`# eval run ${summary.run_id}`);
  L.push('');
  L.push(`model=${summary.model} judge=${summary.judge ?? 'off'} commit=${summary.commit}`);
  L.push('');
  L.push(`## headline`);
  L.push(`- pass@1: ${(o.pass_at_1 * 100).toFixed(1)}%  (${o.trials} trials)`);
  L.push(`- pass^${summary.trials_per_task}: ${(o.pass_all_k * 100).toFixed(1)}% of tasks passed every trial`);
  L.push(`- regression suite: ${(summary.by_suite.regression.pass_at_1 * 100).toFixed(1)}%  capability suite: ${(summary.by_suite.capability.pass_at_1 * 100).toFixed(1)}%`);
  L.push('');
  L.push(`## failure modes (rates)`);
  const r = summary.failure_modes.rates;
  L.push(`Tool-Skip ${(r.TSR * 100).toFixed(1)}% · Result-Ignore ${(r.RIR * 100).toFixed(1)}% · Output-Fabrication ${(r.OFR * 100).toFixed(1)}% · Unnecessary-Tool-Use ${(r.UTR * 100).toFixed(1)}% · Boundary-Violation ${(r.BVR * 100).toFixed(1)}% · Clean ${(r.CTUR * 100).toFixed(1)}%`);
  L.push('');
  L.push(`## cost & latency`);
  L.push(`- total $${summary.cost.total_usd.toFixed(4)} · per successful task $${summary.cost.per_successful_task_usd?.toFixed(4) ?? 'n/a'} · p50 $${summary.cost.p50_usd.toFixed(4)} · p95 $${summary.cost.p95_usd.toFixed(4)}`);
  L.push(`- latency p50 ${summary.latency.p50_ms}ms · p95 ${summary.latency.p95_ms}ms · p99 ${summary.latency.p99_ms}ms · ttft≈ p50 ${summary.latency.ttft_p50_ms}ms`);
  L.push(`- tool calls p50 ${summary.efficiency.tool_calls_p50} · p95 ${summary.efficiency.tool_calls_p95} · redundant ${(summary.efficiency.redundant_call_rate * 100).toFixed(1)}% · schema-valid ${(summary.efficiency.schema_valid_rate * 100).toFixed(0)}%`);
  L.push('');
  const failed = summary.tasks.filter((t) => t.pass_at_1 < 1);
  L.push(`## failing tasks (${failed.length}/${summary.tasks.length})`);
  for (const t of failed) {
    L.push(`- **${t.id}** [${t.suite}/${t.task_type}] pass@1=${(t.pass_at_1 * 100).toFixed(0)}% modes=${t.failure_modes.join(',')}`);
    for (const c of t.failed_checks.slice(0, 4)) L.push(`  - ${c}`);
  }
  if (prev) {
    L.push('');
    L.push(`## vs previous run`);
    for (const t of summary.tasks) {
      const before = prev[`task.${t.id}.pass_at_1`];
      if (before != null) {
        const delta = t.pass_at_1 - before;
        if (Math.abs(delta) > 0.001) {
          L.push(`- ${t.id}: ${(before * 100).toFixed(0)}% → ${(t.pass_at_1 * 100).toFixed(0)}% (${delta > 0 ? '+' : ''}${(delta * 100).toFixed(0)}pp)`);
        }
      }
    }
  }
  return L.join('\n') + '\n';
}

// ---------- main ----------

async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runId = `${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${gitSha()}`;
  const outDir = opts.out ?? path.join(EVALS, 'results', runId);
  mkdirSync(path.join(outDir, 'traces'), { recursive: true });

  let tasks = loadTasks(opts.suite);
  if (opts.tasks) tasks = tasks.filter((t) => opts.tasks!.has(t.id));
  if (!tasks.length) throw new Error('no tasks selected');

  const jobs: { task: EvalTask; trial: number }[] = [];
  for (const task of tasks) {
    for (let k = 0; k < opts.trials; k++) jobs.push({ task, trial: k });
  }

  const trials: TrialResult[] = [];
  let done = 0;
  await pool(jobs, opts.parallel, async ({ task, trial }) => {
    try {
      const { result, trace } = await runTrial(task, trial, opts, runId);
      trials.push(result);
      const dir = path.join(outDir, 'traces', task.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `trial-${trial}.json`), JSON.stringify(trace, null, 2));
      result.trace_file = `traces/${task.id}/trial-${trial}.json`;
    } catch (err) {
      trials.push({
        task_id: task.id,
        trial,
        pass: false,
        verdicts: [{ grader: 'runner', type: 'deterministic', verdict: 'fail', detail: String(err) }],
        failure_mode: 'Tool-Skip',
        step_labels: [],
        tool_calls: 0,
        steps: 0,
        truncated: false,
        cost_usd: 0,
        latency_ms: 0,
        ttft_ms: 0,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        error: String(err),
      });
    }
    done++;
    process.stderr.write(`\r${done}/${jobs.length} trials`);
  });
  process.stderr.write('\n');

  // Deterministic order regardless of completion order.
  trials.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.trial - b.trial);

  const summary = aggregate(tasks, trials, runId, opts);
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ opts: { suite: opts.suite, model: opts.model, judge: opts.judge }, ...summary }, null, 2));
  writeFileSync(path.join(outDir, 'trials.json'), JSON.stringify(trials, null, 2));

  // score history — tracked at evals/history.jsonl so it persists with the
  // repo (per commit) rather than living only in the ignored results dir.
  const histDir = EVALS;
  mkdirSync(histDir, { recursive: true });
  const histLine: Record<string, number | string> = {
    commit: summary.commit,
    run_id: runId,
    suite: opts.suite,
    model: summary.model,
    pass_at_1: summary.overall.pass_at_1,
    'regression.pass_at_1': summary.by_suite.regression.pass_at_1,
    'capability.pass_at_1': summary.by_suite.capability.pass_at_1,
  };
  for (const t of summary.tasks) histLine[`task.${t.id}.pass_at_1`] = t.pass_at_1;
  appendFileSync(path.join(histDir, 'history.jsonl'), JSON.stringify(histLine) + '\n');

  // previous run for the same suite+model → regression diff in the report
  let prev: Record<string, number> | null = null;
  const histPath = path.join(histDir, 'history.jsonl');
  if (existsSync(histPath)) {
    const lines = readFileSync(histPath, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 2; i >= 0; i--) {
      const row = JSON.parse(lines[i]!) as Record<string, number | string>;
      if (row.suite === opts.suite && row.model === summary.model) {
        prev = row as Record<string, number>;
        break;
      }
    }
  }

  const report = renderReport(summary, prev);
  writeFileSync(path.join(outDir, 'report.md'), report);
  process.stdout.write(report);

  if (opts.updateBaseline) {
    writeFileSync(path.join(EVALS, 'baseline.json'), JSON.stringify(summary, null, 2));
    process.stderr.write(`baseline updated → evals/baseline.json\n`);
  }

  // mock mode = reference verification: any failed reference = broken task/harness
  if (opts.model === 'mock') {
    const broken = summary.tasks.filter((t) => t.pass_at_1 < 1);
    if (broken.length) {
      process.stderr.write(
        `\nREFERENCE VERIFICATION FAILED — ${broken.length} task(s) have reference ` +
          `trajectories that fail their own graders (broken task or broken harness):\n` +
          broken.map((t) => `  - ${t.id}: ${t.failed_checks.join(' | ')}`).join('\n') +
          '\n',
      );
      process.exitCode = 1;
    } else {
      process.stderr.write(`\nreference verification OK — all ${summary.tasks.length} reference trajectories pass their graders\n`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Release gate — the eval run's SLO check. Reads a run's summary.json and
 * asserts the combined condition; additionally diffs per-task pass@1 against
 * evals/baseline.json so a run can pass globally yet still fail on a
 * regression-suite task that used to be green.
 *
 *   gate.ts --results <dir>   (default: latest results dir)
 *
 * Exits 1 with the violated conditions listed. CI fails on exit 1.
 * Only meaningful against --model live runs (mock runs verify references,
 * they don't measure the agent).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS = path.resolve(HERE, '..');

interface GateConfig {
  min_completion: number;
  max_p95_latency_ms: number;
  max_cost_per_success_usd: number;
  min_schema_valid: number;
  max_utr: number;
  max_bvr: number;
  max_regression_drop: number;
  min_judge_kappa: number;
}

interface Summary {
  model: string;
  overall: { pass_at_1: number; trials: number };
  latency: { p95_ms: number };
  cost: { per_successful_task_usd: number | null };
  efficiency: { schema_valid_rate: number };
  failure_modes: { rates: { UTR: number; BVR: number } };
  /** Present only when the run carried judge-calibration output. */
  judge_kappa?: number;
  tasks: { id: string; suite: string; pass_at_1: number }[];
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v !== undefined && !v.startsWith('-') ? v : undefined;
  };
  const resultsDir = path.join(EVALS, 'results');
  const latest = readdirSafe(resultsDir)
    .filter((d) => d !== 'history.jsonl')
    .sort()
    .pop();
  const dirArg = get('results');
  if (!dirArg && !latest) {
    throw new Error(`no results directories under ${resultsDir} — pass --results <dir>`);
  }
  const dir = path.resolve(dirArg ?? path.join(resultsDir, latest!));
  const summary = JSON.parse(readFileSync(path.join(dir, 'summary.json'), 'utf8')) as Summary;
  const cfg = JSON.parse(readFileSync(path.join(EVALS, 'gate.config.json'), 'utf8')) as GateConfig;
  const baseline = existsSync(path.join(EVALS, 'baseline.json'))
    ? (JSON.parse(readFileSync(path.join(EVALS, 'baseline.json'), 'utf8')) as Summary)
    : null;

  const violations: string[] = [];
  const ok = (cond: boolean, label: string, detail: string) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
    if (!cond) violations.push(`${label}: ${detail}`);
  };

  ok(
    summary.overall.pass_at_1 >= cfg.min_completion,
    'completion',
    `pass@1 ${(summary.overall.pass_at_1 * 100).toFixed(1)}% ≥ ${cfg.min_completion * 100}%`,
  );
  ok(
    summary.latency.p95_ms <= cfg.max_p95_latency_ms,
    'p95 latency',
    `${summary.latency.p95_ms}ms ≤ ${cfg.max_p95_latency_ms}ms`,
  );
  ok(
    summary.cost.per_successful_task_usd === null ||
      summary.cost.per_successful_task_usd <= cfg.max_cost_per_success_usd,
    'cost per resolution',
    `$${summary.cost.per_successful_task_usd?.toFixed(4) ?? 'n/a'} ≤ $${cfg.max_cost_per_success_usd}`,
  );
  ok(
    summary.efficiency.schema_valid_rate >= cfg.min_schema_valid,
    'schema-valid',
    `${(summary.efficiency.schema_valid_rate * 100).toFixed(1)}% ≥ ${cfg.min_schema_valid * 100}%`,
  );
  ok(
    summary.failure_modes.rates.UTR <= cfg.max_utr,
    'unnecessary-tool-use',
    `UTR ${(summary.failure_modes.rates.UTR * 100).toFixed(1)}% ≤ ${cfg.max_utr * 100}%`,
  );
  ok(
    summary.failure_modes.rates.BVR <= cfg.max_bvr,
    'boundary violations',
    `BVR ${(summary.failure_modes.rates.BVR * 100).toFixed(1)}% ≤ ${cfg.max_bvr * 100}% (zero tolerance)`,
  );
  if (summary.judge_kappa != null) {
    ok(
      summary.judge_kappa >= cfg.min_judge_kappa,
      'judge kappa',
      `kappa ${summary.judge_kappa.toFixed(3)} ≥ ${cfg.min_judge_kappa}`,
    );
  } else {
    console.log('SKIP  judge kappa                       summary has no judge_kappa');
  }

  // Per-task regression on the regression suite — baseline pass@1 minus
  // current must not exceed the allowed drop.
  if (baseline) {
    const baseByTask = new Map(baseline.tasks.map((t) => [t.id, t.pass_at_1]));
    const drops = summary.tasks
      .filter((t) => t.suite === 'regression')
      .map((t) => ({ id: t.id, drop: (baseByTask.get(t.id) ?? 0) - t.pass_at_1 }))
      .filter((d) => d.drop > cfg.max_regression_drop);
    ok(
      drops.length === 0,
      'regression-suite regression',
      drops.length ? `dropped: ${drops.map((d) => `${d.id} -${(d.drop * 100).toFixed(0)}pp`).join(', ')}` : 'no task dropped >15pp',
    );
  } else {
    console.log('SKIP  regression-suite regression   no baseline.json yet');
  }

  console.log('');
  if (violations.length) {
    console.log(`GATE FAILED — ${violations.length} violation(s)`);
    process.exitCode = 1;
  } else {
    console.log('GATE PASSED');
  }
}

function readdirSafe(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

main();

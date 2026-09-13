import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeEvidence, RUBRIC_TEXT, type JudgeVerdict } from './judge.ts';
import type { JudgeDimension } from './types.ts';

/**
 * Judge calibration — the three numbers that decide whether an LLM judge is
 * allowed near a release gate:
 *
 *   --bootstrap <results_dir>   emit <dir>/labels.jsonl: one row per
 *                               (task, trial, judge dimension) with the
 *                               judge's verdict and a blank human_verdict
 *                               for a reviewer to fill against the trace.
 *
 *   --labels <results_dir>      score filled labels: Cohen's kappa (3-class),
 *                               precision/recall of judge-fail vs human-fail,
 *                               unknown rate. Raw agreement is reported but
 *                               NEVER used as the headline — it flatters
 *                               judges on pass-heavy distributions.
 *
 *   --variance <results_dir> [--rerun N]   re-judge every stored evidence
 *                               block N times; reports flip rate (verdict
 *                               changed vs the recorded one) and unanimity.
 *                               High variance = the rubric is ambiguous.
 *
 * Gate a judge on: kappa ≥ 0.6, fail-precision ≥ 0.9 (don't cry wolf on a
 * release gate), unknown rate ≤ 15%, flip rate ≤ 10%.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS = path.resolve(HERE, '..');

interface TraceFile {
  task_id: string;
  trial: number;
  judge_evidence?: Record<string, string>;
  verdicts: { grader: string; type: string; verdict: string; detail?: string }[];
  failure_mode: string;
}

interface LabelRow {
  task_id: string;
  trial: number;
  dimension: string;
  judge_verdict: string;
  judge_detail?: string;
  trace_file: string;
  human_verdict?: 'pass' | 'fail' | 'unknown';
}

function traceFiles(dir: string): { file: string; trace: TraceFile }[] {
  const tracesDir = path.join(dir, 'traces');
  const out: { file: string; trace: TraceFile }[] = [];
  if (!existsSync(tracesDir)) return out;
  for (const taskDir of readdirSync(tracesDir)) {
    for (const f of readdirSync(path.join(tracesDir, taskDir))) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(tracesDir, taskDir, f);
      try {
        out.push({ file, trace: JSON.parse(readFileSync(file, 'utf8')) as TraceFile });
      } catch {
        /* unreadable trace — skip */
      }
    }
  }
  return out;
}

// ---------- bootstrap ----------

function bootstrap(dir: string): void {
  const rows: LabelRow[] = [];
  for (const { file, trace } of traceFiles(dir)) {
    for (const v of trace.verdicts.filter((v) => v.type === 'llm_judge')) {
      rows.push({
        task_id: trace.task_id,
        trial: trace.trial,
        dimension: v.grader.replace(/^judge:/, ''),
        judge_verdict: v.verdict,
        judge_detail: v.detail,
        trace_file: path.relative(dir, file),
      });
    }
  }
  const out = path.join(dir, 'labels.jsonl');
  writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`wrote ${rows.length} label rows → ${out}`);
  console.log('Fill in human_verdict (pass|fail|unknown) after reading each trace_file, then run --labels.');
}

// ---------- kappa / precision-recall ----------

const CATS = ['pass', 'fail', 'unknown'] as const;

function cohensKappa(a: string[], b: string[]): number {
  const n = a.length;
  if (!n) return 0;
  let po = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) po++;
  po /= n;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const c of a) countA.set(c, (countA.get(c) ?? 0) + 1);
  for (const c of b) countB.set(c, (countB.get(c) ?? 0) + 1);
  let pe = 0;
  for (const c of CATS) pe += ((countA.get(c) ?? 0) / n) * ((countB.get(c) ?? 0) / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

function scoreLabels(dir: string): void {
  const file = path.join(dir, 'labels.jsonl');
  if (!existsSync(file)) throw new Error(`no labels.jsonl in ${dir} — run --bootstrap first`);
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LabelRow);
  const labeled = rows.filter((r) => r.human_verdict);
  if (!labeled.length) throw new Error('labels.jsonl has no filled human_verdict rows');
  const skipped = rows.length - labeled.length;

  const report = (name: string, sub: LabelRow[]) => {
    const jv = sub.map((r) => r.judge_verdict);
    const hv = sub.map((r) => r.human_verdict!);
    const kappa = cohensKappa(jv, hv);
    const agree = jv.filter((v, i) => v === hv[i]).length / sub.length;

    // binary view: "fail" is the positive class — the judge's job at a gate
    // is catching real failures, not applauding passes.
    const decided = sub.filter((r) => r.human_verdict !== 'unknown' && r.judge_verdict !== 'unknown');
    const tp = decided.filter((r) => r.judge_verdict === 'fail' && r.human_verdict === 'fail').length;
    const fp = decided.filter((r) => r.judge_verdict === 'fail' && r.human_verdict === 'pass').length;
    const fn = decided.filter((r) => r.judge_verdict === 'pass' && r.human_verdict === 'fail').length;
    const prec = tp + fp ? tp / (tp + fp) : null;
    const rec = tp + fn ? tp / (tp + fn) : null;
    const unknown = sub.filter((r) => r.judge_verdict === 'unknown').length / sub.length;

    console.log(
      `${name.padEnd(14)} n=${String(sub.length).padStart(3)}  kappa=${kappa.toFixed(3)}  ` +
        `raw-agree=${(agree * 100).toFixed(0)}%  ` +
        `fail-precision=${prec === null ? 'n/a' : (prec * 100).toFixed(0) + '%'}  ` +
        `fail-recall=${rec === null ? 'n/a' : (rec * 100).toFixed(0) + '%'}  ` +
        `judge-unknown=${(unknown * 100).toFixed(0)}%`,
    );
    return { kappa, prec, rec, unknown, n: sub.length };
  };

  console.log(`\njudge calibration — ${labeled.length} labeled rows (${skipped} unlabeled skipped)\n`);
  const overall = report('ALL', labeled);
  for (const dim of new Set(labeled.map((r) => r.dimension))) {
    report(dim, labeled.filter((r) => r.dimension === dim));
  }

  const gate =
    overall.kappa >= 0.6 &&
    overall.prec !== null &&
    overall.prec >= 0.9 &&
    overall.unknown <= 0.15;
  console.log(
    `\njudge gate: kappa≥0.6 ${overall.kappa >= 0.6 ? 'OK' : 'FAIL'} · ` +
      `fail-precision≥0.9 ${overall.prec !== null && overall.prec >= 0.9 ? 'OK' : 'FAIL'} · ` +
      `unknown≤15% ${overall.unknown <= 0.15 ? 'OK' : 'FAIL'} → ${gate ? 'CALIBRATED' : 'NOT CALIBRATED — do not gate deploys on this judge'}`,
  );
  process.exitCode = gate ? 0 : 1;
}

// ---------- variance ----------

async function variance(dir: string, rerun: number): Promise<void> {
  interface Job {
    task_id: string;
    trial: number;
    dim: JudgeDimension;
    evidence: string;
    original: string;
  }
  const jobs: Job[] = [];
  for (const { trace } of traceFiles(dir)) {
    for (const [dim, evidence] of Object.entries(trace.judge_evidence ?? {})) {
      if (!(dim in RUBRIC_TEXT)) continue; // unknown dims have no rubric to replay
      const original = trace.verdicts.find((v) => v.grader === `judge:${dim}`)?.verdict ?? 'unknown';
      jobs.push({ task_id: trace.task_id, trial: trace.trial, dim: dim as JudgeDimension, evidence, original });
    }
  }
  if (!jobs.length) {
    throw new Error(`no judge_evidence in ${dir}/traces — re-run evals with --judge on first`);
  }

  const results = new Map<string, string[]>();
  let done = 0;
  for (const j of jobs) {
    const verdicts: string[] = [j.original];
    for (let k = 0; k < rerun; k++) {
      try {
        const v: JudgeVerdict = await judgeEvidence(j.dim, j.evidence);
        verdicts.push(v.verdict);
      } catch {
        verdicts.push('error');
      }
    }
    results.set(`${j.task_id}:${j.trial}:${j.dim}`, verdicts);
    process.stderr.write(`\rre-judged ${++done}/${jobs.length}`);
  }
  process.stderr.write('\n');

  // flip rate = fraction of reruns disagreeing with the recorded verdict;
  // unanimity = all N+1 verdicts identical.
  const perDim = new Map<string, { flips: number; total: number; unanimous: number; cells: number }>();
  for (const [key, vs] of results) {
    const dim = key.split(':').pop()!;
    const rec = vs[0]!;
    const reruns = vs.slice(1);
    const flips = reruns.filter((v) => v !== rec).length;
    const d = perDim.get(dim) ?? { flips: 0, total: 0, unanimous: 0, cells: 0 };
    d.flips += flips;
    d.total += reruns.length;
    d.cells++;
    if (new Set(vs).size === 1) d.unanimous++;
    perDim.set(dim, d);
  }
  console.log(`\njudge variance — ${jobs.length} cells × ${rerun} reruns\n`);
  let allFlips = 0, allTotal = 0, allUnanimous = 0;
  for (const [dim, d] of [...perDim.entries()].sort()) {
    allFlips += d.flips; allTotal += d.total; allUnanimous += d.unanimous;
    console.log(
      `${dim.padEnd(14)} flip-rate=${((d.flips / Math.max(1, d.total)) * 100).toFixed(1)}%  ` +
        `unanimous=${d.unanimous}/${d.cells}`,
    );
  }
  const flipRate = allFlips / Math.max(1, allTotal);
  console.log(
    `\noverall flip-rate=${(flipRate * 100).toFixed(1)}% · unanimous cells ${allUnanimous}/${jobs.length} → ` +
      `${flipRate <= 0.1 ? 'STABLE' : 'UNSTABLE — sharpen rubrics before gating'}`,
  );
  process.exitCode = flipRate <= 0.1 ? 0 : 1;
}

// ---------- main ----------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v !== undefined && !v.startsWith('-') ? v : undefined;
  };
  const dirArg = get('bootstrap') ?? get('labels') ?? get('variance');
  const resultsDir = path.join(EVALS, 'results');
  const latest = (existsSync(resultsDir) ? readdirSync(resultsDir) : [])
    .filter((d) => d !== 'history.jsonl')
    .sort()
    .pop();
  if (!dirArg && !latest) throw new Error(`no results directories under ${resultsDir}`);
  const dir = dirArg ? path.resolve(dirArg) : path.join(resultsDir, latest!);

  if (argv.includes('--bootstrap')) bootstrap(dir);
  else if (argv.includes('--labels')) scoreLabels(dir);
  else if (argv.includes('--variance')) await variance(dir, Number(get('rerun') ?? 3));
  else {
    console.error('usage: calibrate.ts --bootstrap|--labels|--variance [results_dir] [--rerun N]');
    process.exitCode = 2;
  }
}

await main();

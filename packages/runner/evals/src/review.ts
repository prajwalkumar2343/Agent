import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Review queue — ranks the trials a human should look at first after a run.
 * Priority order: boundary violations > fabrication-ish failures > unknown
 * judge verdicts (the escape hatch doing its job — a human must resolve
 * them) > low-confidence judge fails > everything else that failed.
 *
 * Output: <dir>/review-queue.json + a printed summary. Each entry points at
 * the trace file — the reviewer's one click away from the full trajectory.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVALS = path.resolve(HERE, '..');

interface TraceFile {
  task_id: string;
  trial: number;
  verdicts: { grader: string; type: string; verdict: string; detail?: string }[];
  failure_mode: string;
  step_labels: { step: number; tool: string; label: number; why: string }[];
  ctx_summary?: { run_payload?: { status?: string } };
}

interface QueueItem {
  task_id: string;
  trial: number;
  priority: number;
  reason: string;
  trace_file: string;
  failure_mode: string;
  failed: string[];
}

function pri(trace: TraceFile): { priority: number; reason: string } {
  const labels = trace.step_labels ?? [];
  if (labels.some((l) => l.why === 'boundary violation' || l.why === 'secret probe'))
    return { priority: 0, reason: 'boundary violation in trajectory' };
  const failedDet = trace.verdicts.filter((v) => v.type === 'deterministic' && v.verdict === 'fail');
  if (failedDet.some((v) => /report_mentions_pr|run_succeeded|output_not_contains/.test(v.grader)))
    return { priority: 1, reason: 'possible fabricated result' };
  const unknowns = trace.verdicts.filter((v) => v.verdict === 'unknown');
  if (unknowns.length)
    return { priority: 2, reason: `judge returned unknown: ${unknowns.map((v) => v.grader).join(', ')}` };
  const lowConfFails = trace.verdicts.filter(
    (v) => v.type === 'llm_judge' && v.verdict === 'fail' && v.detail?.startsWith('low'),
  );
  if (lowConfFails.length)
    return { priority: 3, reason: `low-confidence judge fail: ${lowConfFails.map((v) => v.grader).join(', ')}` };
  if (failedDet.length) return { priority: 4, reason: 'deterministic check failed' };
  return { priority: 5, reason: 'judge verdict disagreement / spot-check' };
}

function main(): void {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--results');
  const dir = path.resolve(
    i >= 0
      ? argv[i + 1]!
      : path.join(
          EVALS,
          'results',
          readdirSync(path.join(EVALS, 'results')).filter((d) => d !== 'history.jsonl').sort().pop()!,
        ),
  );
  const tracesDir = path.join(dir, 'traces');
  if (!existsSync(tracesDir)) throw new Error(`no traces dir under ${dir}`);

  const queue: QueueItem[] = [];
  for (const taskDir of readdirSync(tracesDir)) {
    for (const f of readdirSync(path.join(tracesDir, taskDir))) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(tracesDir, taskDir, f);
      const trace = JSON.parse(readFileSync(file, 'utf8')) as TraceFile;
      const anyFail = trace.verdicts.some((v) => v.verdict !== 'pass');
      if (!anyFail) continue;
      const { priority, reason } = pri(trace);
      queue.push({
        task_id: trace.task_id,
        trial: trace.trial,
        priority,
        reason,
        trace_file: path.relative(dir, file),
        failure_mode: trace.failure_mode,
        failed: trace.verdicts.filter((v) => v.verdict !== 'pass').map((v) => v.grader),
      });
    }
  }
  queue.sort((a, b) => a.priority - b.priority || a.task_id.localeCompare(b.task_id));
  writeFileSync(path.join(dir, 'review-queue.json'), JSON.stringify(queue, null, 2));

  const byPri = new Map<number, number>();
  for (const q of queue) byPri.set(q.priority, (byPri.get(q.priority) ?? 0) + 1);
  console.log(`review queue: ${queue.length} item(s) → ${path.join(dir, 'review-queue.json')}`);
  const names = ['boundary violations', 'possible fabrication', 'judge unknowns', 'low-confidence fails', 'det failures', 'spot-checks'];
  for (const [p, n] of [...byPri.entries()].sort()) console.log(`  p${p} ${names[p]}: ${n}`);
  for (const q of queue.slice(0, 10)) console.log(`  [p${q.priority}] ${q.task_id} t${q.trial} — ${q.reason} (${q.trace_file})`);
}

main();

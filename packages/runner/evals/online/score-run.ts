import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeEvidence } from '../src/judge.ts';
import { costUsd } from '../src/pricing.ts';
import type { AgentTrace } from '../../src/trace.ts';

/**
 * Online scoring — samples production AgentTraces (written by the runner cli
 * via RUN_TRACE_PATH) and attaches lightweight judge verdicts + signal
 * metrics. Async by design: never on the request path; runs on a cron or a
 * tail of the trace directory.
 *
 *   score-run.ts --traces <dir> [--all] [--judge on]
 *
 * Output: evals/online/scores.jsonl — one row per sampled trace:
 *   {ts, session_id, sampled_reason, run_status, schema_valid, tool_calls,
 *    loop_flag, latency_ms, cost_usd, judge: {dim: verdict}}
 *
 * Sampling: deterministic hash of session_id — a trace is either always
 * sampled or never (no re-roll per run), plus always-sample conditions for
 * failures and flagged trajectories.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ONLINE = HERE;
const CFG = JSON.parse(readFileSync(path.join(ONLINE, 'sampling.json'), 'utf8')) as {
  sample_rate: number;
  max_traces_per_hour: number;
  judge: { default_model: string; dimensions: string[] };
};

interface ScoreRow {
  ts: string;
  session_id: string;
  sampled_reason: string;
  run_status: 'success' | 'failed' | 'unknown';
  schema_valid: boolean;
  tool_calls: number;
  loop_flag: boolean;
  latency_ms: number;
  cost_usd: number;
  judge?: Record<string, string>;
}

function sampled(sessionId: string): boolean {
  const h = createHash('sha256').update(sessionId).digest();
  return h[0]! / 256 < CFG.sample_rate;
}

/** Cheap structural check — the "schema-valid" production signal. */
function schemaValid(t: AgentTrace): boolean {
  return (
    typeof t.meta?.agent === 'string' &&
    typeof t.meta?.session_id === 'string' &&
    Array.isArray(t.llm) &&
    Array.isArray(t.tools) &&
    typeof t.finish_reason === 'string'
  );
}

function loopFlag(t: AgentTrace): boolean {
  // Prefer raw toolCalls (local traces); shipped traces strip them, so fall
  // back to the hashed tool spans.
  const seq =
    t.toolCalls?.length
      ? t.toolCalls.map((c) => `${c.toolName}:${JSON.stringify(c.input)}`)
      : (t.tools ?? []).map((s) => `${s.tool_name}:${s.tool_input_hash}`);
  let run = 1;
  for (let i = 1; i < seq.length; i++) {
    run = seq[i] === seq[i - 1] ? run + 1 : 1;
    if (run >= 3) return true;
  }
  return false;
}

/** Bounded evidence digest for the online judge — spans, not transcript. */
function onlineEvidence(t: AgentTrace, _dim: string): string {
  const lines = (t.toolCalls ?? []).map(
    (c) =>
      `- ${c.toolName} step=${c.step}${c.isError ? ' [ERROR]' : ''} ` +
      `${c.isError ? String(c.output ?? '').slice(0, 200) : 'ok'}`,
  );
  const spanLines = (t.tools ?? []).map(
    (s) => `- ${s.tool_name} step=${s.step}${s.tool_success ? '' : ' [ERROR:' + (s.tool_error_class ?? '?') + ']'} ${s.tool_latency_ms}ms`,
  );
  return [
    `agent=${t.meta.agent} model=${t.meta.model_id}`,
    `final report:\n${(t.text ?? '').slice(0, 1200)}`,
    `--- tool calls (${lines.length}) ---`,
    ...lines.slice(0, 60),
    `--- tool spans (${spanLines.length}) ---`,
    ...spanLines.slice(0, 60),
  ].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tracesDir = path.resolve(get('traces') ?? process.env.TRACE_DIR ?? path.join(ONLINE, 'traces'));
  const judge = argv.includes('--judge');
  const all = argv.includes('--all');
  if (!existsSync(tracesDir)) {
    console.log(`no trace dir at ${tracesDir} — nothing to score`);
    return;
  }

  const outFile = path.join(ONLINE, 'scores.jsonl');
  const scoredSessions = new Set(
    existsSync(outFile)
      ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as ScoreRow).session_id)
      : [],
  );

  const rows: ScoreRow[] = [];
  for (const f of readdirSync(tracesDir).filter((f) => f.endsWith('.json'))) {
    let t: AgentTrace;
    try {
      t = JSON.parse(readFileSync(path.join(tracesDir, f), 'utf8')) as AgentTrace;
    } catch {
      continue;
    }
    const sid = t.meta?.session_id ?? f;
    if (scoredSessions.has(sid)) continue;

    const ok = schemaValid(t);
    // A completed run = the agent loop ended on 'stop' without truncation.
    const failed = t.truncated || (t.finish_reason && t.finish_reason !== 'stop');
    const flagged = (t.toolCalls ?? []).some((c) => c.isError) || (t.tools ?? []).some((s) => !s.tool_success);
    const reasons: string[] = [];
    if (all || sampled(sid)) reasons.push('sampled');
    if (!ok) reasons.push('schema_invalid');
    if (failed) reasons.push('run_failed');
    if (flagged) reasons.push('tool_errors');
    if (!reasons.length) continue;

    const row: ScoreRow = {
      ts: new Date().toISOString(),
      session_id: sid,
      sampled_reason: reasons.join('+'),
      run_status: failed ? 'failed' : 'success',
      schema_valid: ok,
      tool_calls: t.toolCalls.length,
      loop_flag: loopFlag(t),
      latency_ms: t.meta.total_ms ?? 0,
      cost_usd: costUsd(t.meta.model_id ?? '', {
        input_tokens: t.usage?.input_tokens ?? 0,
        output_tokens: t.usage?.output_tokens ?? 0,
        cache_read_tokens: t.usage?.cache_read_tokens ?? 0,
        cache_creation_tokens: t.usage?.cache_creation_tokens ?? 0,
      }),
    };

    if (judge) {
      row.judge = {};
      for (const dim of CFG.judge.dimensions) {
        try {
          const v = await judgeEvidence(dim as never, onlineEvidence(t, dim));
          row.judge[dim] = v.verdict;
        } catch {
          row.judge[dim] = 'unknown';
        }
      }
    }
    rows.push(row);
    scoredSessions.add(sid);
  }

  mkdirSync(ONLINE, { recursive: true });
  for (const r of rows) appendFileSync(outFile, JSON.stringify(r) + '\n');
  console.log(`scored ${rows.length} trace(s) → ${outFile} (${scoredSessions.size} total seen)`);
  writeFileSync(path.join(ONLINE, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), scored: rows.length }, null, 2));
}

await main();

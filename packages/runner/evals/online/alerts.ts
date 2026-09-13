import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sustained-drop alerting over evals/online/scores.jsonl.
 *
 * Buckets score rows into `window_minutes` windows and fires alerts on
 * sustained degradation — a single bad window doesn't page; magnitude +
 * duration + sample size all required (from sampling.json → alerts).
 *
 *   alerts.ts [--scores <file>] [--now <iso>]   (now is injectable for tests)
 *
 * Alert rules:
 *   completion_drop      window pass rate ≥ magnitude_pp below baseline for
 *                        ≥ consecutive_windows, each with ≥ min_samples
 *   schema_valid_floor   schema_valid rate < min over a 15-min window
 *   cost_band            p50 cost/run > band in latest window
 *   tool_loop            any loop_flag, or p95 tool_calls > max
 *   fallback_rate_spike  failed-run share > threshold
 *   faithfulness_decline sampled-window judge-faithfulness fail rate > max
 *
 * Writes alerts.active.json + prints. Exit 1 while any alert fires — a cron
 * can wire it to Slack/pager.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ONLINE = HERE;
const CFG = JSON.parse(readFileSync(path.join(ONLINE, 'sampling.json'), 'utf8')) as {
  window_minutes: number;
  alerts: {
    completion_drop: { magnitude_pp: number; min_samples: number; consecutive_windows: number };
    schema_valid_floor: { min_rate: number; window_minutes: number };
    cost_band_usd_per_run: number;
    tool_loop: { identical_calls_in_a_row: number; max_tool_calls: number };
    fallback_rate_spike: { share_failed_over: number; min_samples: number };
    faithfulness_decline: { max_fail_rate: number; min_samples: number };
  };
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

interface Alert {
  rule: string;
  severity: 'page' | 'warn';
  detail: string;
  window: string;
}

const quantile = (xs: number[], q: number) =>
  xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]! : 0;

function main(): void {
  const argv = process.argv.slice(2);
  const get = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v !== undefined && !v.startsWith('-') ? v : undefined;
  };
  const scoresFile = path.resolve(get('scores') ?? path.join(ONLINE, 'scores.jsonl'));
  const now = get('now') ? new Date(get('now')!).getTime() : Date.now();
  if (!existsSync(scoresFile)) {
    console.log('no scores.jsonl — nothing to alert on');
    return;
  }
  const rows = readFileSync(scoresFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ScoreRow)
    .filter((r) => new Date(r.ts).getTime() <= now);

  const winMs = CFG.window_minutes * 60_000;
  const bucket = (ts: number) => Math.floor(ts / winMs);
  const byWindow = new Map<number, ScoreRow[]>();
  for (const r of rows) {
    const b = bucket(new Date(r.ts).getTime());
    byWindow.set(b, [...(byWindow.get(b) ?? []), r]);
  }
  const windows = [...byWindow.entries()].sort(([a], [b]) => a - b);
  const baseline = rows.filter((r) => new Date(r.ts).getTime() < now - CFG.alerts.completion_drop.consecutive_windows * winMs);
  const baseRate = baseline.length ? baseline.filter((r) => r.run_status === 'success').length / baseline.length : 1;

  const alerts: Alert[] = [];
  const winLabel = (b: number) => new Date(b * winMs).toISOString().slice(0, 16);

  // --- completion_drop: sustained N windows ---
  const dropCfg = CFG.alerts.completion_drop;
  const recent = windows.slice(-dropCfg.consecutive_windows);
  if (
    recent.length === dropCfg.consecutive_windows &&
    recent.every(([, rs]) => rs.length >= dropCfg.min_samples) &&
    recent.every(
      ([, rs]) =>
        baseRate - rs.filter((r) => r.run_status === 'success').length / rs.length >=
        dropCfg.magnitude_pp / 100,
    )
  ) {
    const last = recent.at(-1)!;
    const rate = last[1].filter((r) => r.run_status === 'success').length / last[1].length;
    alerts.push({
      rule: 'completion_drop',
      severity: 'page',
      detail: `pass rate ${(rate * 100).toFixed(0)}% vs baseline ${(baseRate * 100).toFixed(0)}% for ${recent.length} consecutive windows`,
      window: winLabel(last[0]),
    });
  }

  // --- schema_valid_floor ---
  const svCfg = CFG.alerts.schema_valid_floor;
  const svSince = now - svCfg.window_minutes * 60_000;
  const svRows = rows.filter((r) => new Date(r.ts).getTime() > svSince);
  if (svRows.length) {
    const rate = svRows.filter((r) => r.schema_valid).length / svRows.length;
    if (rate < svCfg.min_rate) {
      alerts.push({
        rule: 'schema_valid_floor',
        severity: 'page',
        detail: `schema-valid ${(rate * 100).toFixed(1)}% < ${svCfg.min_rate * 100}% for ${svCfg.window_minutes}min (${svRows.length} runs)`,
        window: winLabel(bucket(now)),
      });
    }
  }

  // --- latest-window checks ---
  const latest = windows.at(-1);
  if (latest) {
    const [b, rs] = latest;
    const costs = rs.map((r) => r.cost_usd).filter((c) => c > 0);
    if (costs.length && quantile([...costs], 0.5) > CFG.alerts.cost_band_usd_per_run) {
      alerts.push({
        rule: 'cost_band',
        severity: 'warn',
        detail: `p50 cost/run $${quantile([...costs], 0.5).toFixed(3)} > $${CFG.alerts.cost_band_usd_per_run}`,
        window: winLabel(b),
      });
    }
    const loops = rs.filter((r) => r.loop_flag).length;
    const p95calls = quantile(rs.map((r) => r.tool_calls), 0.95);
    if (loops > 0 || p95calls > CFG.alerts.tool_loop.max_tool_calls) {
      alerts.push({
        rule: 'tool_loop',
        severity: 'warn',
        detail: `${loops} loop-flagged run(s); p95 tool_calls ${p95calls} (max ${CFG.alerts.tool_loop.max_tool_calls})`,
        window: winLabel(b),
      });
    }
    const fsCfg = CFG.alerts.fallback_rate_spike;
    if (rs.length >= fsCfg.min_samples) {
      const share = rs.filter((r) => r.run_status === 'failed').length / rs.length;
      if (share > fsCfg.share_failed_over) {
        alerts.push({
          rule: 'fallback_rate_spike',
          severity: 'page',
          detail: `${(share * 100).toFixed(0)}% of sampled runs failed (threshold ${fsCfg.share_failed_over * 100}%)`,
          window: winLabel(b),
        });
      }
    }
    const faCfg = CFG.alerts.faithfulness_decline;
    const judged = rs.filter((r) => r.judge?.faithfulness);
    if (judged.length >= faCfg.min_samples) {
      const fail = judged.filter((r) => r.judge!.faithfulness === 'fail').length / judged.length;
      if (fail > faCfg.max_fail_rate) {
        alerts.push({
          rule: 'faithfulness_decline',
          severity: 'page',
          detail: `faithfulness fail rate ${(fail * 100).toFixed(0)}% > ${faCfg.max_fail_rate * 100}% on ${judged.length} sampled`,
          window: winLabel(b),
        });
      }
    }
  }

  writeFileSync(
    path.join(ONLINE, 'alerts.active.json'),
    JSON.stringify({ at: new Date(now).toISOString(), alerts }, null, 2),
  );
  if (!alerts.length) {
    console.log(`no alerts — ${rows.length} scored rows over ${windows.length} window(s)`);
    return;
  }
  for (const a of alerts) console.log(`[${a.severity.toUpperCase()}] ${a.rule}: ${a.detail} (window ${a.window})`);
  process.exitCode = 1;
}

main();

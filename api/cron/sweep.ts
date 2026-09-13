import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  advance,
  createRunStoreFromEnv,
  dueReports,
  type RunStore,
} from '../../packages/store/src/index.ts';
import { requireEnv, type Run } from '../../packages/shared/src/index.ts';
import {
  createPostHogMcp,
  flagMetrics,
  formatMetricLine,
  posthogMcpConfigFromEnv,
} from '../../packages/posthog/src/index.ts';
import { postToThread } from '../_lib/notify.ts';
import { secretMatches } from '../_lib/http.ts';

export const config = { maxDuration: 60 };

/**
 * Metric-report line for a due report — flag exposure counts + the exception
 * guardrail from PostHog MCP. A PostHog outage degrades to the flag's last
 * known rollout state rather than killing the sweep.
 */
async function metricLine(run: Run): Promise<string> {
  if (!run.flag_key) return 'No flag key recorded for this run.';
  try {
    const m = await flagMetrics(createPostHogMcp(posthogMcpConfigFromEnv()), run.flag_key);
    return formatMetricLine(run.flag_key, run.rollout_pct, m);
  } catch (err) {
    console.error(`posthog metrics failed for ${run.thread_ts}`, err);
    return `Flag \`${run.flag_key}\` at *${run.rollout_pct ?? 0}%*. Metric pull failed — see logs.`;
  }
}

/** Post each due report exactly once; retire the run when the schedule empties. */
async function sweepRun(store: RunStore, run: Run, now: number): Promise<number> {
  const due = dueReports(run, now);
  for (const t of due) {
    const label = run.report_schedule.indexOf(t);
    await postToThread(run.channel, run.thread_ts, `Report #${label + 1} — ${await metricLine(run)}`);
    // Record each report as soon as it posts — a mid-loop failure must not
    // make the next sweep repost the ones that already went out.
    await store.update(run.thread_ts, (r) => {
      const fired_reports = [...r.fired_reports, t];
      if (r.report_schedule.length > 0 && fired_reports.length >= r.report_schedule.length) {
        return advance(r, 'done', { fired_reports });
      }
      const patched = { ...r, fired_reports, updated_at: now };
      return r.state === 'live' ? advance(patched, 'monitor') : patched;
    });
  }
  return due.length;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = typeof req.query.secret === 'string' ? req.query.secret : '';
  if (!secretMatches(secret, requireEnv('CRON_SECRET'))) {
    return res.status(401).send('invalid cron secret');
  }

  const store = createRunStoreFromEnv();
  const now = Date.now();
  let reported = 0;
  for (const run of await store.list()) {
    if (run.state !== 'live' && run.state !== 'monitor') continue;
    try {
      reported += await sweepRun(store, run, now);
    } catch (err) {
      console.error(`sweep failed for ${run.thread_ts}`, err); // one bad run must not stall the rest
    }
  }
  res.status(200).json({ ok: true, reported });
}

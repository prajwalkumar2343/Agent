import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import {
  IllegalTransitionError,
  RunNotFoundError,
  createRunStoreFromEnv,
  transitionRun,
} from '../../packages/store/src/index.ts';
import {
  RUN_COMPLETE_SECRET_HEADER,
  requireEnv,
  type Run,
  type RunsCompletePayload,
} from '../../packages/shared/src/index.ts';
import { dmUser, postToThread } from '../_lib/notify.ts';
import { header, readRawBody, secretMatches } from '../_lib/http.ts';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

/** Report card posted to the run thread + DM'd to the PM for a go/no-go. */
async function notifyReport(run: Run): Promise<void> {
  const sim = run.sim_report;
  const lines = [
    `*Build finished* — ${run.spec?.title ?? 'feature'}`,
    run.pr_url ? `PR: ${run.pr_url}` : 'PR: (none returned)',
    sim ? `Simulation: *${sim.verdict}* (${Math.round(sim.confidence * 100)}%) — ${sim.summary}` : '',
  ].filter(Boolean);
  await postToThread(run.channel, run.thread_ts, lines.join('\n'));
  if (run.pm_id) {
    await dmUser(
      run.pm_id,
      `Spec "${run.spec?.title}" built (${run.pr_url ?? 'no PR'}). ` +
        `Sim verdict: ${sim?.verdict ?? 'n/a'}. Reply in the thread with e.g. "roll out to 15%" to deploy.`,
    );
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  if (!secretMatches(header(req, RUN_COMPLETE_SECRET_HEADER), requireEnv('RUN_CALLBACK_SECRET'))) {
    return res.status(401).send('invalid run secret');
  }

  const payload = JSON.parse(raw) as RunsCompletePayload;
  if (!payload.thread_ts || (payload.status !== 'success' && payload.status !== 'failed')) {
    return res.status(400).send('invalid payload');
  }

  const store = createRunStoreFromEnv();
  try {
    if (payload.status === 'failed') {
      const run = await transitionRun(store, payload.thread_ts, 'failed');
      waitUntil(
        postToThread(run.channel, run.thread_ts, `Build failed — logs: ${payload.log_url ?? 'n/a'}`)
          .catch((err) => console.error('notify failed', err)),
      );
      return res.status(200).json({ ok: true, state: 'failed' });
    }

    let run = await transitionRun(store, payload.thread_ts, 'reported', {
      pr_url: payload.pr_url,
      pr_number: payload.pr_number,
      branch: payload.branch,
      sim_report: payload.sim_report,
    });
    run = await transitionRun(store, payload.thread_ts, 'await_rollout');
    res.status(200).json({ ok: true, state: run.state });
    waitUntil(notifyReport(run).catch((err) => console.error('notifyReport failed', err)));
  } catch (err) {
    if (err instanceof RunNotFoundError) return res.status(404).send('unknown run');
    if (err instanceof IllegalTransitionError) return res.status(409).send(err.message);
    throw err;
  }
}

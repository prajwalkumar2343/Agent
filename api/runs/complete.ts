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
  type RunState,
  type RunsCompletePayload,
} from '../../packages/shared/src/index.ts';
import {
  agentBranchPrefix,
  audit,
  isExpectedPrUrl,
} from '../../packages/guard/src/index.ts';
import { dmUser, postToThread } from '../_lib/notify.ts';
import { header, readRawBody, secretMatches } from '../_lib/http.ts';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

/**
 * States reachable only after a success callback was processed
 * (await_rollout and everything downstream of it). A retried success
 * landing on one of these is an idempotent duplicate. 'reported' is
 * excluded — it means the first callback died mid-transition, and 'failed'
 * is reachable from pre-build states, so both stay real conflicts (409).
 */
const POST_SUCCESS: ReadonlySet<RunState> = new Set([
  'await_rollout',
  'await_ci',
  'live',
  'monitor',
  'done',
  'rolled_back',
]);

/** Report goes to the PM's DM for a go/no-go; the requester's thread gets one closing line. */
async function notifyReport(run: Run): Promise<void> {
  const sim = run.sim_report;
  const lines = [
    `*Build finished* — ${run.spec?.title ?? 'feature'} (${run.idea ?? 'no idea recorded'})`,
    run.pr_url ? `PR: ${run.pr_url}` : 'PR: (none returned)',
    sim ? `Simulation: *${sim.verdict}* (${Math.round(sim.confidence * 100)}%) — ${sim.summary}` : '',
    'Reply here with e.g. "roll out to 15%" to deploy, or in the request thread.',
  ].filter(Boolean);
  // Independent sends — a PM-DM failure must not eat the requester update.
  if (run.pm_id) {
    await dmUser(run.pm_id, lines.join('\n')).catch((err) =>
      console.error(`dmUser failed for ${run.thread_ts}`, err),
    );
  }
  await postToThread(
    run.channel,
    run.thread_ts,
    'Build finished — the PR and sim report are with the PM for review.',
  ).catch((err) => console.error(`postToThread failed for ${run.thread_ts}`, err));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  if (!secretMatches(header(req, RUN_COMPLETE_SECRET_HEADER), requireEnv('RUN_CALLBACK_SECRET'))) {
    return res.status(401).send('invalid run secret');
  }

  let payload: RunsCompletePayload;
  try {
    payload = JSON.parse(raw) as RunsCompletePayload;
  } catch {
    return res.status(400).send('invalid payload');
  }
  if (!payload.thread_ts || (payload.status !== 'success' && payload.status !== 'failed')) {
    return res.status(400).send('invalid payload');
  }
  // Shape-check the fields that later drive merges: branch must be an
  // agent/* ref, pr_url must point at the product repo's pulls, and
  // pr_number feeds /pulls/N lookups. A successful build must report its
  // branch — the CI webhook matches awaiting runs by branch, so a missing
  // one strands the run in await_ci.
  const validBranch =
    typeof payload.branch === 'string' && payload.branch.startsWith(agentBranchPrefix());
  if (payload.branch ? !validBranch : payload.status === 'success') {
    return res.status(400).send('invalid branch');
  }
  if (payload.pr_url && !isExpectedPrUrl(payload.pr_url, requireEnv('PRODUCT_REPO'))) {
    return res.status(400).send('invalid pr_url');
  }
  if (
    payload.pr_number != null &&
    (!Number.isInteger(payload.pr_number) || payload.pr_number <= 0)
  ) {
    return res.status(400).send('invalid pr_number');
  }
  // mergePr() in the CI webhook drives off pr_number — a success that
  // reports a PR URL without its number can never be merged.
  if (payload.status === 'success' && payload.pr_url && payload.pr_number == null) {
    return res.status(400).send('invalid pr_number');
  }
  waitUntil(audit('run_complete', { thread_ts: payload.thread_ts, status: payload.status, pr: payload.pr_url }));

  const store = createRunStoreFromEnv();
  try {
    if (payload.status === 'failed') {
      // A duplicate failure callback on an already-failed run is an
      // idempotent retry — the machine rejects failed → failed, so
      // acknowledge without transitioning again.
      const existing = await store.get(payload.thread_ts);
      if (existing?.state === 'failed') {
        return res.status(200).json({ ok: true, state: 'failed' });
      }
      const run = await transitionRun(store, payload.thread_ts, 'failed');
      waitUntil(
        (async () => {
          // PM gets the log URL; the requester's thread stays one line.
          if (run.pm_id) {
            await dmUser(
              run.pm_id,
              `Build failed for "${run.spec?.title ?? run.idea ?? 'feature'}" — logs: ${payload.log_url ?? 'n/a'}`,
            ).catch((err) => console.error('notify failed', err));
          }
          await postToThread(
            run.channel,
            run.thread_ts,
            "That build didn't make it — the PM has the logs.",
          ).catch((err) => console.error('notify failed', err));
        })(),
      );
      return res.status(200).json({ ok: true, state: 'failed' });
    }

    // Mirror the failed short-circuit: a duplicate success callback on a
    // run already past 'reported' is an idempotent retry — the machine
    // rejects e.g. await_rollout → reported, so acknowledge it without
    // transitioning again.
    const existing = await store.get(payload.thread_ts);
    if (existing && POST_SUCCESS.has(existing.state)) {
      return res.status(200).json({ ok: true, state: existing.state });
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

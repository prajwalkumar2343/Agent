import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import {
  createPostHogClient,
  findFlagByKey,
  posthogConfigFromEnv,
  setRolloutPercentage,
} from '../../packages/posthog/src/index.ts';
import {
  createRunStoreFromEnv,
  scheduleReports,
  transitionRun,
  type RunStore,
} from '../../packages/store/src/index.ts';
import { requireEnv, type Run } from '../../packages/shared/src/index.ts';
import { checksGreen, mergePr } from '../_lib/github.ts';
import { dmUser, postToThread } from '../_lib/notify.ts';
import { header, readRawBody } from '../_lib/http.ts';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

interface CheckRunEvent {
  action?: string;
  check_run?: {
    head_sha: string;
    conclusion: string | null;
    status: string;
    check_suite?: { head_branch?: string };
  };
}

function verifyGitHubSignature(raw: string, signature: string): boolean {
  const secret = process.env.GH_WEBHOOK_SECRET;
  if (!secret) return true; // webhook secret is optional until configured — see docs/ENV.md
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function findAwaitingRun(store: RunStore, branch: string): Promise<Run | null> {
  const runs = await store.list();
  return runs.find((r) => r.state === 'await_ci' && r.branch === branch) ?? null;
}

/** Green CI → merge → flag rollout → live + report schedule. Red → back to PM. */
async function onChecksSettled(store: RunStore, run: Run, sha: string): Promise<void> {
  const green = await checksGreen(sha);
  if (!green) {
    await transitionRun(store, run.thread_ts, 'await_rollout', { pending_rollout: undefined });
    await dmUser(
      run.pm_id,
      `CI went red on ${run.pr_url ?? run.branch}. Reply "roll out to N%" once it's fixed to re-queue.`,
    );
    return;
  }
  const pct = run.pending_rollout?.pct ?? 0;
  if (run.pr_number) await mergePr(run.pr_number, sha);
  const ph = createPostHogClient(posthogConfigFromEnv());
  const flagId = run.flag_id ?? (run.flag_key ? (await findFlagByKey(ph, run.flag_key))?.id : undefined);
  if (run.flag_key && flagId != null) await setRolloutPercentage(ph, flagId, pct);
  await transitionRun(store, run.thread_ts, 'live', {
    rollout_pct: pct,
    flag_id: flagId,
    report_schedule: scheduleReports(Date.now()),
  });
  await postToThread(
    run.channel,
    run.thread_ts,
    `Merged ${run.pr_url ?? ''} — \`${run.flag_key}\` now live at *${pct}%*. ` +
      'Metric reports land here at +12h/+24h/+48h.',
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  if (!verifyGitHubSignature(raw, header(req, 'x-hub-signature-256'))) {
    return res.status(401).send('invalid signature');
  }

  res.status(200).send('ok');
  if (header(req, 'x-github-event') !== 'check_run') return;

  const payload = JSON.parse(raw) as CheckRunEvent;
  const check = payload.check_run;
  const branch = check?.check_suite?.head_branch;
  if (payload.action !== 'completed' || !check || !branch) return;

  const store = createRunStoreFromEnv();
  const run = await findAwaitingRun(store, branch);
  if (!run) return;

  waitUntil(
    onChecksSettled(store, run, check.head_sha).catch((err) =>
      console.error(`github webhook: checks-settled failed for ${run.thread_ts}`, err),
    ),
  );
}

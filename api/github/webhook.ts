import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import {
  createPostHogMcp,
  findFlagByKey,
  posthogMcpConfigFromEnv,
  setRolloutPercentage,
} from '../../packages/posthog/src/index.ts';
import {
  createRunStoreFromEnv,
  scheduleReports,
  transitionRun,
  type RunStore,
} from '../../packages/store/src/index.ts';
import { requireEnv, type Run } from '../../packages/shared/src/index.ts';
import { checksGreen, mergePr, prFiles } from '../_lib/github.ts';
import { dmUser, postToThread } from '../_lib/notify.ts';
import { header, readRawBody } from '../_lib/http.ts';
import {
  audit,
  pipelinePaused,
  reviewDiffForMerge,
  rolloutMaxPct,
  scanPrFiles,
  summarizeFindings,
} from '../../packages/guard/src/index.ts';

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
  if (!secret) {
    // Fail closed: a forged "CI green" check_run would otherwise trigger a
    // merge. ALLOW_INSECURE_WEBHOOKS=1 exists for local dev only — never
    // set it on the Vercel deployment.
    return process.env.ALLOW_INSECURE_WEBHOOKS === '1';
  }
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
  // Merge gate: scan the PR diff before anything reaches main — deterministic
  // scan first, then a guardian-style second-opinion review of the same diff
  // against the spec. block/hold/suspicious all stop auto-merge and hand the
  // PR to the PM — the branch and PR stay open for human review.
  if (run.pr_number) {
    const files = await prFiles(run.pr_number);
    const findings = scanPrFiles(files);
    const review = await reviewDiffForMerge({
      specTitle: run.spec?.title,
      specSummary: run.spec?.summary,
      flagKey: run.flag_key,
      files,
    });
    if (review?.verdict === 'suspicious') {
      findings.push(
        ...review.reasons.map((detail) => ({
          severity: 'hold' as const,
          rule: 'merge-review',
          detail: `reviewer: ${detail}`,
        })),
      );
    }
    const stopping = findings.filter((f) => f.severity !== 'warn');
    await audit('merge_gate', {
      thread_ts: run.thread_ts,
      pr_number: run.pr_number,
      verdict: stopping.length ? 'held' : 'clean',
      findings,
      review: review?.verdict ?? 'skipped',
    });
    if (stopping.length) {
      await transitionRun(store, run.thread_ts, 'await_rollout', { pending_rollout: undefined });
      const msg =
        `CI is green but the merge gate held ${run.pr_url ?? run.branch}:\n` +
        summarizeFindings(stopping) +
        '\nReview the diff — merge it manually on GitHub or close it.';
      await postToThread(run.channel, run.thread_ts, msg);
      await dmUser(run.pm_id, msg);
      return;
    }
  }

  if (pipelinePaused()) {
    await audit('merge_paused', { thread_ts: run.thread_ts, pr_number: run.pr_number });
    await transitionRun(store, run.thread_ts, 'await_rollout', { pending_rollout: undefined });
    await dmUser(run.pm_id, `Pipeline is paused (AGENT_PAUSED) — ${run.pr_url ?? run.branch} was NOT merged.`);
    return;
  }

  const pct = Math.min(run.pending_rollout?.pct ?? 0, rolloutMaxPct());
  if (run.pr_number) await mergePr(run.pr_number, sha);
  const ph = createPostHogMcp(posthogMcpConfigFromEnv());
  const flag = run.flag_key ? await findFlagByKey(ph, run.flag_key) : null;
  if (flag) await setRolloutPercentage(ph, flag, pct);
  await transitionRun(store, run.thread_ts, 'live', {
    rollout_pct: pct,
    flag_id: flag?.id ?? run.flag_id,
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

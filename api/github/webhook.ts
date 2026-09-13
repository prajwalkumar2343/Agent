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
import { createDeployStoreFromEnv } from '../../packages/deploy/src/index.ts';
import { requireEnv, type Run } from '../../packages/shared/src/index.ts';
import { checksGreen, mergePr, prFiles } from '../_lib/github.ts';
import { dmUser, postToThread } from '../_lib/notify.ts';
import { header, readRawBody } from '../_lib/http.ts';
import {
  audit,
  deployMaxUsers,
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
  const pct = Math.min(run.pending_rollout?.pct ?? 0, rolloutMaxPct());
  // User-count deploys take the Postgres cohort path instead of PostHog.
  const users = Math.min(run.pending_rollout?.users ?? 0, deployMaxUsers());
  // Everything up to the merge hits GitHub unguarded — a 5xx, 403, or
  // branch-protection rejection would otherwise strand the run in await_ci
  // (waitUntil only logs). On failure drop back to await_rollout — the same
  // await_ci edge the CI-red path uses — and hand the re-queue to the PM.
  try {
    const green = await checksGreen(sha);
    if (!green) {
      await transitionRun(store, run.thread_ts, 'await_rollout', { pending_rollout: undefined });
      await dmUser(
        run.pm_id,
        `CI went red on ${run.pr_url ?? run.branch}. Reply "roll out to N%" once it's fixed to re-queue.`,
      ).catch((err) => console.error(`dmUser failed for ${run.thread_ts}`, err));
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
        // Independent catches: one Slack failure must not suppress the other send.
        await postToThread(run.channel, run.thread_ts, msg).catch((err) =>
          console.error(`postToThread failed for ${run.thread_ts}`, err),
        );
        await dmUser(run.pm_id, msg).catch((err) =>
          console.error(`dmUser failed for ${run.thread_ts}`, err),
        );
        return;
      }
    }

    if (pipelinePaused()) {
      await audit('merge_paused', { thread_ts: run.thread_ts, pr_number: run.pr_number });
      await transitionRun(store, run.thread_ts, 'await_rollout', { pending_rollout: undefined });
      await dmUser(
        run.pm_id,
        `Pipeline is paused (AGENT_PAUSED) — ${run.pr_url ?? run.branch} was NOT merged.`,
      ).catch((err) => console.error(`dmUser failed for ${run.thread_ts}`, err));
      return;
    }

    if (run.pr_number) await mergePr(run.pr_number, sha);
  } catch (err) {
    console.error(`github webhook: pre-merge failed for ${run.thread_ts}`, err);
    await audit('pre_merge_failed', {
      thread_ts: run.thread_ts,
      pr_number: run.pr_number,
      error: err instanceof Error ? err.message : String(err),
    }).catch((e) => console.error(`audit failed for ${run.thread_ts}`, e));
    // Best-effort back to await_rollout — if the failure came after an inner
    // transition (CI red, gate hold, paused) the edge is illegal and this
    // just logs; the DM below still goes out either way.
    await transitionRun(store, run.thread_ts, 'await_rollout', {
      pending_rollout: undefined,
    }).catch((e) =>
      console.error(`await_rollout transition failed for ${run.thread_ts}`, e),
    );
    await dmUser(
      run.pm_id,
      `Auto-merge for ${run.pr_url ?? run.branch} hit an error: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Check the PR on GitHub in case it merged anyway, then reply "roll out to N%" to re-queue.',
    ).catch((e) => console.error(`dmUser failed for ${run.thread_ts}`, e));
    return;
  }
  // The merge is already done, so a PostHog/Postgres failure must not strand
  // the run in await_ci — land it 'live' at 0 and hand the rollout to a human
  // (the same escape hatch as the over-cap path).
  let flagId = run.flag_id;
  let rolledOut = false;
  let cohortSize = 0;
  try {
    if (users > 0) {
      // Postgres cohort: first `users` rows of the users table get the flag.
      if (!run.flag_key) throw new Error('run has no flag_key to deploy under');
      const result = await createDeployStoreFromEnv().deploy(run.flag_key, users, {
        thread_ts: run.thread_ts,
        actor: 'pipeline',
      });
      cohortSize = result.cohort_size;
    } else {
      const ph = createPostHogMcp(posthogMcpConfigFromEnv());
      const flag = run.flag_key ? await findFlagByKey(ph, run.flag_key) : null;
      flagId = flag?.id ?? run.flag_id;
      if (flag) await setRolloutPercentage(ph, flag, pct);
    }
    rolledOut = true;
  } catch (err) {
    console.error(`rollout failed for ${run.thread_ts}`, err);
    await audit('rollout_failed', {
      thread_ts: run.thread_ts,
      flag_key: run.flag_key,
      pct,
      users,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // The merge already happened, so a failed 'live' transition must not
  // strand the run in await_ci — audit it and hand the state to a human.
  try {
    await transitionRun(store, run.thread_ts, 'live', {
      rollout_pct: rolledOut ? pct : 0,
      rollout_users: rolledOut ? cohortSize : 0,
      flag_id: flagId,
      report_schedule: scheduleReports(Date.now()),
    });
  } catch (err) {
    console.error(`live transition failed for ${run.thread_ts}`, err);
    // Independent catches: a KV/Slack failure here must not lose the
    // human-reconcile DM.
    await audit('live_transition_failed', {
      thread_ts: run.thread_ts,
      pr_number: run.pr_number,
      error: err instanceof Error ? err.message : String(err),
    }).catch((e) => console.error(`audit failed for ${run.thread_ts}`, e));
    await dmUser(
      run.pm_id,
      `Merged ${run.pr_url ?? run.branch} but the run failed to transition to live — ` +
        'a human needs to reconcile its state.',
    ).catch((e) => console.error(`dmUser failed for ${run.thread_ts}`, e));
    return;
  }
  const msg = rolledOut
    ? users > 0
      ? `Merged ${run.pr_url ?? ''} — \`${run.flag_key}\` now live for *${cohortSize}* users ` +
        '(Postgres cohort). Metric reports land here at +12h/+24h/+48h.'
      : `Merged ${run.pr_url ?? ''} — \`${run.flag_key}\` now live at *${pct}%*. ` +
        'Metric reports land here at +12h/+24h/+48h.'
    : `Merged ${run.pr_url ?? ''} — but the rollout for \`${run.flag_key}\` failed ` +
      `(target: ${users > 0 ? `${users} users` : `${pct}%`}). ` +
      'Live at *0* — a human can set the rollout directly in PostHog or Postgres. ' +
      'Metric reports still land here at +12h/+24h/+48h.';
  // Independent catches: one Slack failure must not suppress the other send.
  await postToThread(run.channel, run.thread_ts, msg).catch((err) =>
    console.error(`postToThread failed for ${run.thread_ts}`, err),
  );
  if (!rolledOut) {
    await dmUser(run.pm_id, msg).catch((err) =>
      console.error(`dmUser failed for ${run.thread_ts}`, err),
    );
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  if (!verifyGitHubSignature(raw, header(req, 'x-hub-signature-256'))) {
    return res.status(401).send('invalid signature');
  }

  if (header(req, 'x-github-event') !== 'check_run') return res.status(200).send('ok');

  let payload: CheckRunEvent;
  try {
    payload = JSON.parse(raw) as CheckRunEvent;
  } catch {
    return res.status(400).send('invalid payload');
  }
  const check = payload.check_run;
  const branch = check?.check_suite?.head_branch;
  if (payload.action !== 'completed' || !check || !branch) {
    return res.status(200).send('ok');
  }

  res.status(200).send('ok');
  const store = createRunStoreFromEnv();
  const run = await findAwaitingRun(store, branch);
  if (!run) return;

  waitUntil(
    onChecksSettled(store, run, check.head_sha).catch((err) =>
      console.error(`github webhook: checks-settled failed for ${run.thread_ts}`, err),
    ),
  );
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { pmUserIds, requireEnv, ACTION } from '../../packages/shared/src/index.ts';
import { postMessage, verifySlackSignature } from '../../packages/slack-kit/src/index.ts';
import {
  IllegalTransitionError,
  createRunStoreFromEnv,
  transitionRun,
} from '../../packages/store/src/index.ts';
import {
  createPostHogMcp,
  findFlagByKey,
  posthogMcpConfigFromEnv,
  setRolloutPercentage,
} from '../../packages/posthog/src/index.ts';
import {
  audit,
  deployMaxUsers,
  pipelinePaused,
  rolloutMaxPct,
} from '../../packages/guard/src/index.ts';
import { createDeployStoreFromEnv, deployConfigured } from '../../packages/deploy/src/index.ts';
import { header, readRawBody } from '../_lib/http.ts';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

interface InteractionPayload {
  type: string;
  team?: { id?: string };
  user?: { id?: string };
  response_url?: string;
  actions?: { action_id?: string; value?: string }[];
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
  container?: { thread_ts?: string; message_ts?: string };
}

async function respondEphemeral(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  });
}

/**
 * The card lives in the run's thread — Slack hands us the parent thread_ts
 * via the container (or, on older payloads, the message itself). DM'd cards
 * fall back to the message ts, which is the run key for DM-started runs.
 */
function threadTsOf(payload: InteractionPayload): string {
  return (
    payload.container?.thread_ts ??
    payload.message?.thread_ts ??
    payload.container?.message_ts ??
    payload.message?.ts ??
    ''
  );
}

async function note(channel: string, threadTs: string, text: string): Promise<void> {
  await postMessage({ channel, thread_ts: threadTs, text });
}

export async function dispatchAction(
  actionId: string,
  value: string,
  userId: string,
  payload: InteractionPayload,
  respond: (text: string) => Promise<void>,
): Promise<void> {
  const threadTs = threadTsOf(payload);
  if (!threadTs) return respond('Could not resolve which run this card belongs to.');
  const store = createRunStoreFromEnv();
  const run = await store.get(threadTs);
  if (!run) return respond('No run on this thread — it may predate the pipeline.');
  const channel = payload.channel?.id ?? run.channel;

  if (actionId === ACTION.ROLLOUT_CONFIRM) {
    const pct = Number(value);
    const cap = rolloutMaxPct();
    if (!Number.isInteger(pct) || pct <= 0 || pct > cap) {
      return respond(`Invalid rollout — pct must be a whole number between 1 and ${cap}.`);
    }
    try {
      await transitionRun(store, run.thread_ts, 'await_ci', {
        pending_rollout: { pct, confirmed_by: userId },
      });
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return respond(`Run is "${run.state}" — a rollout can't be queued from here.`);
      }
      throw err;
    }
    await audit('rollout_confirmed', { thread_ts: run.thread_ts, user: userId, pct });
    await note(
      channel,
      run.thread_ts,
      `Rollout to *${pct}%* queued by <@${userId}> — ` +
        `${run.pr_url ?? 'the PR'} merges automatically when CI is green.`,
    );
    return respond(`Queued — merging at ${pct}% once checks pass.`);
  }

  if (actionId === ACTION.DEPLOY_CONFIRM) {
    const users = Number(value);
    const cap = deployMaxUsers();
    if (!Number.isInteger(users) || users <= 0 || users > cap) {
      return respond(`Invalid deploy — user count must be a whole number between 1 and ${cap}.`);
    }
    try {
      await transitionRun(store, run.thread_ts, 'await_ci', {
        pending_rollout: { users, confirmed_by: userId },
      });
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return respond(`Run is "${run.state}" — a deploy can't be queued from here.`);
      }
      throw err;
    }
    await audit('deploy_confirmed', { thread_ts: run.thread_ts, user: userId, users });
    await note(
      channel,
      run.thread_ts,
      `Deploy to *${users}* users queued by <@${userId}> — ` +
        `${run.pr_url ?? 'the PR'} merges automatically when CI is green, ` +
        'then the Postgres cohort is written.',
    );
    return respond(`Queued — deploying to ${users} users once checks pass.`);
  }

  if (actionId === ACTION.ROLLOUT_CANCEL) {
    await audit('rollout_cancelled', { thread_ts: run.thread_ts, user: userId });
    return respond('Cancelled — nothing was queued.');
  }

  if (actionId === ACTION.ROLLBACK_CONFIRM) {
    if (run.state !== 'live' && run.state !== 'monitor') {
      return respond(`Run is "${run.state}" — only live/monitor runs can roll back.`);
    }
    if (run.flag_key && process.env.POSTHOG_API_KEY) {
      const ph = createPostHogMcp(posthogMcpConfigFromEnv());
      const flag = await findFlagByKey(ph, run.flag_key);
      if (flag) await setRolloutPercentage(ph, flag, 0);
    }
    // Clear the Postgres cohort too — best-effort like the PostHog zeroing;
    // a Postgres outage must not block the rollback.
    if (run.flag_key && deployConfigured()) {
      await createDeployStoreFromEnv()
        .undeploy(run.flag_key, { thread_ts: run.thread_ts, actor: `pm:${userId}` })
        .catch((err) =>
          console.error(`cohort undeploy failed for ${run.thread_ts}`, err),
        );
    }
    await transitionRun(store, run.thread_ts, 'rolled_back', { rollout_pct: 0, rollout_users: 0 });
    await audit('rollback_confirmed', { thread_ts: run.thread_ts, user: userId });
    await note(channel, run.thread_ts, `Rolled back by <@${userId}> — \`${run.flag_key}\` is at *0%*.`);
    return respond('Rolled back to 0%.');
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  const timestamp = header(req, 'x-slack-request-timestamp');
  const signature = header(req, 'x-slack-signature');
  if (!verifySlackSignature(requireEnv('SLACK_SIGNING_SECRET'), timestamp, raw, signature)) {
    return res.status(401).send('invalid signature');
  }

  const payloadStr = new URLSearchParams(raw).get('payload');
  if (!payloadStr) return res.status(400).send('missing payload');
  let payload: InteractionPayload;
  try {
    payload = JSON.parse(payloadStr) as InteractionPayload;
  } catch {
    return res.status(400).send('invalid payload');
  }
  if (payload.team?.id !== requireEnv('SLACK_TEAM_ID')) {
    return res.status(403).send('unauthorized workspace');
  }

  res.status(200).send('');

  if (payload.type !== 'block_actions' || !payload.response_url) return;
  const actionId = payload.actions?.[0]?.action_id ?? '';
  const known = Object.values(ACTION) as string[];
  if (!known.includes(actionId)) return;

  const userId = payload.user?.id ?? '';
  const respond = (text: string) =>
    respondEphemeral(payload.response_url!, text).catch((err) =>
      console.error('respondEphemeral failed', err),
    );

  // Control-plane actions are PM-only — a random workspace member (or a
  // forged-looking click) must never advance rollout/rollback.
  if (!pmUserIds().includes(userId)) {
    waitUntil(
      audit('interaction_denied', { user: userId, action: actionId }).then(() =>
        respond('Only PMs can drive rollouts.'),
      ),
    );
    return;
  }
  if (pipelinePaused()) {
    waitUntil(respond('Pipeline is paused (AGENT_PAUSED) — no actions right now.'));
    return;
  }

  waitUntil(
    dispatchAction(
      actionId,
      payload.actions?.[0]?.value ?? '',
      userId,
      payload,
      respond,
    ).catch((err) => {
      console.error(`interaction ${actionId} failed`, err);
      return respond(`Action failed — ${err instanceof Error ? err.message : err}`);
    }),
  );
}

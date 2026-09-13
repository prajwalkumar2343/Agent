import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { createRunStoreFromEnv } from '../../packages/store/src/index.ts';
import {
  audit,
  deployMaxUsers,
  pipelinePaused,
  rolloutMaxPct,
} from '../../packages/guard/src/index.ts';
import {
  RUN_COMPLETE_SECRET_HEADER,
  pmUserIds,
  requireEnv,
  type Run,
} from '../../packages/shared/src/index.ts';
import {
  deployConfirmBlocks,
  rollbackConfirmBlocks,
  rolloutConfirmBlocks,
} from '../../packages/slack-kit/src/index.ts';
import { postToThread } from '../_lib/notify.ts';
import { header, readRawBody, secretMatches } from '../_lib/http.ts';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

/**
 * Internal endpoint — api/slack/events (A2) forwards PM replies in run
 * threads here. Handles the PM-only natural-language control plane:
 * "roll out to 15%" → confirm card; "rollback" → rollback card.
 * The button clicks land on api/slack/interactions.
 */
interface ParseBody {
  thread_ts?: string;
  channel?: string;
  user?: string;
  text?: string;
}

const PCT_RE = /(\d{1,3})\s*%/;
const USERS_RE = /(\d+)\s*users?\b/i;

/** The PM control plane for one run — exported for tests; the PM allowlist lives in the HTTP handler below. */
export async function handle(run: Run, user: string, text: string): Promise<void> {
  if (run.state === 'await_rollout') {
    // User-count deploy ("roll out to 500 users") → Postgres cohort on merge.
    // Checked before the % path so "… N users" never reads as a bare number.
    const usersMatch = USERS_RE.exec(text);
    if (usersMatch) {
      const users = Number(usersMatch[1]);
      const ucap = deployMaxUsers();
      if (!Number.isInteger(users) || users <= 0) {
        await postToThread(run.channel, run.thread_ts, 'Say e.g. "roll out to 500 users" — a positive whole number.');
        return;
      }
      if (users > ucap) {
        await audit('deploy_over_cap', { thread_ts: run.thread_ts, user, users, cap: ucap });
        await postToThread(
          run.channel,
          run.thread_ts,
          `${users} users exceeds the automated cap (${ucap}). A human can deploy wider directly in Postgres.`,
        );
        return;
      }
      await audit('deploy_requested', { thread_ts: run.thread_ts, user, users });
      await postToThread(run.channel, run.thread_ts, `Deploy to ${users} users?`, deployConfirmBlocks(users));
      return;
    }
    const pct = Number(PCT_RE.exec(text)?.[1]);
    const cap = rolloutMaxPct();
    if (!Number.isInteger(pct) || pct <= 0 || pct > 100) {
      await postToThread(run.channel, run.thread_ts, 'Say e.g. "roll out to 15%" or "roll out to 500 users" — a whole percent between 1 and 100, or a user count.');
      return;
    }
    // Hard cap on the automated path: beyond ROLLOUT_MAX_PCT a human sets
    // the rollout in PostHog directly — NL parsing never gets there.
    if (pct > cap) {
      await audit('rollout_over_cap', { thread_ts: run.thread_ts, user, pct, cap });
      await postToThread(
        run.channel,
        run.thread_ts,
        `${pct}% exceeds the automated cap (${cap}%). A human can roll it higher directly in PostHog.`,
      );
      return;
    }
    await audit('rollout_requested', { thread_ts: run.thread_ts, user, pct });
    await postToThread(run.channel, run.thread_ts, `Roll out to ${pct}%?`, rolloutConfirmBlocks(pct));
    return;
  }
  if ((run.state === 'live' || run.state === 'monitor') && /rollback/i.test(text)) {
    await postToThread(run.channel, run.thread_ts, 'Confirm rollback.', rollbackConfirmBlocks());
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  if (!secretMatches(header(req, RUN_COMPLETE_SECRET_HEADER), requireEnv('RUN_CALLBACK_SECRET'))) {
    return res.status(401).send('invalid run secret');
  }

  let body: ParseBody;
  try {
    body = JSON.parse(raw) as ParseBody;
  } catch {
    return res.status(400).send('invalid payload');
  }
  if (!body.thread_ts || !body.user || !body.text) {
    return res.status(400).send('invalid payload');
  }

  res.status(200).send('ok');
  if (pipelinePaused()) return;
  if (!pmUserIds().includes(body.user)) return; // PM-only control plane

  const run = await createRunStoreFromEnv().get(body.thread_ts);
  if (!run) return;

  waitUntil(handle(run, body.user, body.text).catch((err) => console.error('rollout parse failed', err)));
}

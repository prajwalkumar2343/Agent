import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { createRunStoreFromEnv } from '../../packages/store/src/index.ts';
import { audit, pipelinePaused, rolloutMaxPct } from '../../packages/guard/src/index.ts';
import {
  ACTION,
  RUN_COMPLETE_SECRET_HEADER,
  pmUserIds,
  requireEnv,
  type Run,
} from '../../packages/shared/src/index.ts';
import { postToThread, rolloutConfirmBlocks } from '../_lib/notify.ts';
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

function rollbackBlocks(): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: 'Roll this flag back to *0%*?' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Rollback to 0%' },
          action_id: ACTION.ROLLBACK_CONFIRM,
        },
      ],
    },
  ];
}

async function handle(run: Run, user: string, text: string): Promise<void> {
  if (run.state === 'await_rollout') {
    const pct = Number(PCT_RE.exec(text)?.[1]);
    const cap = rolloutMaxPct();
    if (!Number.isInteger(pct) || pct <= 0 || pct > 100) {
      await postToThread(run.channel, run.thread_ts, 'Say e.g. "roll out to 15%" — a whole percent between 1 and 100.');
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
    await postToThread(run.channel, run.thread_ts, 'Confirm rollback.', rollbackBlocks());
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  if (!secretMatches(header(req, RUN_COMPLETE_SECRET_HEADER), requireEnv('RUN_CALLBACK_SECRET'))) {
    return res.status(401).send('invalid run secret');
  }

  const body = JSON.parse(raw) as ParseBody;
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

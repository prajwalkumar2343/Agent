import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { requireEnv } from '../../packages/shared/src/env';
import { postMessage, verifySlackSignature } from '../../packages/slack-kit/src/index';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

const seenEventIds = new Set<string>();

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function header(req: VercelRequest, name: string): string {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

async function handleIdea(event: SlackEvent): Promise<void> {
  if (!event.channel) return;
  const idea = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
  await postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    text: idea
      ? `On it — turning "${idea.slice(0, 140)}" into a spec. I'll keep you posted in this thread.`
      : "On it — what's the feature idea?",
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  const timestamp = header(req, 'x-slack-request-timestamp');
  const signature = header(req, 'x-slack-signature');
  if (!verifySlackSignature(requireEnv('SLACK_SIGNING_SECRET'), timestamp, raw, signature)) {
    return res.status(401).send('invalid signature');
  }

  const payload = JSON.parse(raw) as {
    type: string;
    challenge?: string;
    team_id?: string;
    event_id?: string;
    event?: SlackEvent;
  };

  if (payload.type === 'url_verification') {
    return res.status(200).json({ challenge: payload.challenge });
  }
  if (payload.team_id !== requireEnv('SLACK_TEAM_ID')) {
    return res.status(403).send('unauthorized workspace');
  }

  res.status(200).send('ok');

  if (payload.type !== 'event_callback' || !payload.event) return;
  const event = payload.event;
  if (event.bot_id || event.subtype) return;
  const isMention = event.type === 'app_mention';
  const isDm = event.type === 'message' && event.channel_type === 'im';
  if (!isMention && !isDm) return;

  const id = payload.event_id ?? '';
  if (seenEventIds.has(id)) return;
  seenEventIds.add(id);
  if (seenEventIds.size > 5000) seenEventIds.clear();

  waitUntil(handleIdea(event).catch((err) => console.error('handleIdea failed', err)));
}

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { pmUserIds, pipelinePaused, requireEnv } from '../../packages/shared/src/env';
import { ACTION } from '../../packages/shared/src/contracts';
import { verifySlackSignature } from '../../packages/slack-kit/src/index';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface InteractionPayload {
  type: string;
  team?: { id?: string };
  user?: { id?: string };
  response_url?: string;
  actions?: { action_id?: string; value?: string }[];
}

async function respondEphemeral(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
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

  const payloadStr = new URLSearchParams(raw).get('payload');
  if (!payloadStr) return res.status(400).send('missing payload');
  const payload = JSON.parse(payloadStr) as InteractionPayload;
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
    console.log(
      JSON.stringify({
        audit: 'interaction_denied',
        at: Date.now(),
        user: userId,
        action: actionId,
      }),
    );
    waitUntil(respond('Only PMs can drive rollouts.'));
    return;
  }
  if (pipelinePaused()) {
    waitUntil(respond('Pipeline is paused (AGENT_PAUSED) — no actions right now.'));
    return;
  }

  waitUntil(
    respond(
      `Received \`${actionId}\` — rollout execution comes online with the rollout workstream.`,
    ),
  );
}

function header(req: VercelRequest, name: string): string {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

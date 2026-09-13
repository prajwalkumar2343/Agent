import { ACTION, requireEnv } from '../../packages/shared/src/index.ts';

/**
 * Slack egress — post to threads / DM PMs / render the rollout card.
 * Kept dependency-free so main works before A2's slack-kit merges; if the
 * card format grows, consolidate into slack-kit (see docs/WORKSTREAMS.md).
 */

async function slackApi<T = Record<string, never>>(method: string, body: object): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireEnv('SLACK_BOT_TOKEN')}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { ok: boolean; error?: string };
  if (!json.ok) throw new Error(`slack ${method} failed: ${json.error}`);
  return json;
}

export function postToThread(
  channel: string,
  threadTs: string,
  text: string,
  blocks?: unknown[],
): Promise<unknown> {
  return slackApi('chat.postMessage', { channel, thread_ts: threadTs, text, blocks });
}

export async function dmUser(userId: string, text: string, blocks?: unknown[]): Promise<unknown> {
  const { channel } = await slackApi<{ channel: { id: string } }>('conversations.open', {
    users: userId,
  });
  return slackApi('chat.postMessage', { channel: channel.id, text, blocks });
}

/** The "roll out to N%?" confirm card — action_ids are a frozen contract. */
export function rolloutConfirmBlocks(pct: number): unknown[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Roll this feature out to *${pct}%* of users?` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: `Roll out ${pct}%` },
          action_id: ACTION.ROLLOUT_CONFIRM,
          value: String(pct),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: ACTION.ROLLOUT_CANCEL,
        },
      ],
    },
  ];
}

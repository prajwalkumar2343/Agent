import { requireEnv } from '../../shared/src/env.ts';

const SLACK_API = 'https://slack.com/api';

type SlackJson<T> = T & { ok: boolean; error?: string };

async function callApi<T = Record<string, never>>(method: string, body: object): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireEnv('SLACK_BOT_TOKEN')}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`slack ${method} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as SlackJson<T>;
  if (!json.ok) throw new Error(`slack ${method} failed: ${json.error}`);
  return json;
}

export interface PostMessageArgs {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
}

export function postMessage(args: PostMessageArgs) {
  return callApi('chat.postMessage', args);
}

export function postEphemeral(args: {
  channel: string;
  user: string;
  text: string;
  thread_ts?: string;
}) {
  return callApi('chat.postEphemeral', args);
}

export async function openIm(userId: string): Promise<string> {
  const r = await callApi<{ channel: { id: string } }>('conversations.open', {
    users: userId,
  });
  return r.channel.id;
}

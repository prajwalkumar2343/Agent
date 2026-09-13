import { openIm, postMessage } from '../../packages/slack-kit/src/index.ts';

/**
 * Slack egress — post to threads / DM PMs. Delegates to packages/slack-kit
 * now that A2 has merged (see docs/WORKSTREAMS.md wiring notes); the
 * signatures stay so handlers don't change. Card builders live in
 * slack-kit/src/cards.ts.
 */

export function postToThread(
  channel: string,
  threadTs: string,
  text: string,
  blocks?: unknown[],
): Promise<unknown> {
  return postMessage({ channel, thread_ts: threadTs, text, blocks });
}

export async function dmUser(userId: string, text: string, blocks?: unknown[]): Promise<unknown> {
  const channel = await openIm(userId);
  return postMessage({ channel, text, blocks });
}

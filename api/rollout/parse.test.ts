import assert from 'node:assert/strict';
import test from 'node:test';

import { handle } from './parse.ts';
import { createRunStoreFromEnv, newRun } from '../../packages/store/src/index.ts';
import { installFetchStub, setBaseEnv } from '../_test/httpFake.ts';
import type { Run } from '../../packages/shared/src/index.ts';

const store = () => createRunStoreFromEnv();
let seq = 0;
const nextTs = () => `1700.${7000 + ++seq}`;

async function awaitRolloutRun(channel = 'C-ideas'): Promise<Run> {
  const ts = nextTs();
  await store().create(
    newRun({ thread_ts: ts, channel, requester_id: 'U-req', idea: 'x' }),
  );
  await store().update(ts, (r) => ({ ...r, state: 'await_rollout', flag_key: 'feat_x' }));
  return (await store().get(ts))!;
}

/** The action_ids inside the last card posted to Slack. */
function lastCardActions(stub: ReturnType<typeof installFetchStub>): { id: string; value?: string }[] {
  const post = stub.jsonTo('chat.postMessage').at(-1) as {
    blocks?: { elements?: { action_id: string; value?: string }[] }[];
  };
  return (post.blocks ?? [])
    .flatMap((b) => b.elements ?? [])
    .map((e) => ({ id: e.action_id, value: e.value }));
}

test('rollout parse: "roll out to N users" posts the deploy confirm card', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    const run = await awaitRolloutRun();
    await handle(run, 'U-pm', 'roll out to 250 users');
    const actions = lastCardActions(stub);
    assert.deepEqual(actions.map((a) => a.id), ['deploy_confirm', 'rollout_cancel']);
    assert.equal(actions[0]!.value, '250');
  } finally {
    stub.restore();
  }
});

test('rollout parse: user counts above the cap never produce a card', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    const run = await awaitRolloutRun();
    await handle(run, 'U-pm', 'roll out to 600 users'); // cap default 500
    const post = stub.jsonTo('chat.postMessage').at(-1) as { text: string };
    assert.match(post.text, /exceeds the automated cap \(500\)/);
  } finally {
    stub.restore();
  }
});

test('rollout parse: the pct path still wins on a % message', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    const run = await awaitRolloutRun();
    await handle(run, 'U-pm', 'roll out to 15%');
    const actions = lastCardActions(stub);
    assert.deepEqual(actions.map((a) => a.id), ['rollout_confirm', 'rollout_cancel']);
    assert.equal(actions[0]!.value, '15');
  } finally {
    stub.restore();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import handler, { dispatchAction } from './interactions.ts';
import { createRunStoreFromEnv, newRun } from '../../packages/store/src/index.ts';
import {
  fakeReq,
  fakeRes,
  installFetchStub,
  setBaseEnv,
  slackSignature,
  waitFor,
} from '../_test/httpFake.ts';

const store = () => createRunStoreFromEnv();
let seq = 0;
const nextTs = () => `1700.${1000 + ++seq}`;

function interactionBody(payload: object): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function basePayload(threadTs: string, overrides: object = {}) {
  return {
    type: 'block_actions',
    team: { id: 'T-test' },
    user: { id: 'U-pm' },
    response_url: 'https://hooks.slack.test/response/1',
    channel: { id: 'C-ideas' },
    container: { thread_ts: threadTs, message_ts: `${threadTs}-card` },
    actions: [{ action_id: 'rollout_confirm', value: '15' }],
    ...overrides,
  };
}

test('slack interactions: rejects bad signatures and missing payloads', async () => {
  setBaseEnv();
  const bad = fakeRes();
  await handler(
    fakeReq('payload=%7B%7D', {
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-slack-signature': 'v0=forged',
    }),
    bad as never,
  );
  assert.equal(bad.statusCode, 401);

  const res = fakeRes();
  const signed = slackSignature('not-a-form');
  await handler(
    fakeReq('not-a-form', {
      'x-slack-request-timestamp': signed.timestamp,
      'x-slack-signature': signed.signature,
    }),
    res as never,
  );
  assert.equal(res.statusCode, 400);
});

test('slack interactions: non-PMs get an ephemeral denial, no state change', async () => {
  setBaseEnv();
  const ts = nextTs();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: ts, channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    );
    const raw = interactionBody(basePayload(ts, { user: { id: 'U-rando' } }));
    const signed = slackSignature(raw);
    const res = fakeRes();
    await handler(
      fakeReq(raw, {
        'x-slack-request-timestamp': signed.timestamp,
        'x-slack-signature': signed.signature,
      }),
      res as never,
    );
    assert.equal(res.statusCode, 200);
    await waitFor(() => stub.to('hooks.slack.test').length === 1);
    const denial = stub.jsonTo('hooks.slack.test')[0] as { text: string };
    assert.match(denial.text, /Only PMs/);
    assert.equal((await store().get(ts))!.state, 'received');
  } finally {
    stub.restore();
  }
});

test('dispatchAction: rollout_confirm queues await_ci with pending_rollout', async () => {
  setBaseEnv();
  const ts = nextTs();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: ts, channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    );
    await store().update(ts, (r) => ({ ...r, state: 'await_rollout' }));

    const replies: string[] = [];
    await dispatchAction('rollout_confirm', '15', 'U-pm', basePayload(ts), async (t) => {
      replies.push(t);
    });

    const run = (await store().get(ts))!;
    assert.equal(run.state, 'await_ci');
    assert.deepEqual(run.pending_rollout, { pct: 15, confirmed_by: 'U-pm' });
    assert.match(replies[0]!, /Queued/);
    const note = stub.jsonTo('chat.postMessage').at(-1) as { text: string };
    assert.match(note.text, /Rollout to \*15%\* queued/);
  } finally {
    stub.restore();
  }
});

test('dispatchAction: rollout pct above the automated cap is refused', async () => {
  setBaseEnv();
  const ts = nextTs();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: ts, channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    );
    await store().update(ts, (r) => ({ ...r, state: 'await_rollout' }));
    const replies: string[] = [];
    await dispatchAction('rollout_confirm', '80', 'U-pm', basePayload(ts), async (t) => {
      replies.push(t);
    });
    assert.match(replies[0]!, /between 1 and 50/);
    assert.equal((await store().get(ts))!.state, 'await_rollout');
  } finally {
    stub.restore();
  }
});

test('dispatchAction: deploy_confirm queues await_ci with pending_rollout.users', async () => {
  setBaseEnv();
  const ts = nextTs();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: ts, channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    );
    await store().update(ts, (r) => ({ ...r, state: 'await_rollout' }));

    const replies: string[] = [];
    await dispatchAction('deploy_confirm', '200', 'U-pm', basePayload(ts), async (t) => {
      replies.push(t);
    });

    const run = (await store().get(ts))!;
    assert.equal(run.state, 'await_ci');
    assert.deepEqual(run.pending_rollout, { users: 200, confirmed_by: 'U-pm' });
    assert.match(replies[0]!, /200 users/);
    const note = stub.jsonTo('chat.postMessage').at(-1) as { text: string };
    assert.match(note.text, /Deploy to \*200\* users queued/);
  } finally {
    stub.restore();
  }
});

test('dispatchAction: deploy_confirm above DEPLOY_MAX_USERS is refused', async () => {
  setBaseEnv();
  const ts = nextTs();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: ts, channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    );
    await store().update(ts, (r) => ({ ...r, state: 'await_rollout' }));
    const replies: string[] = [];
    // default DEPLOY_MAX_USERS = 500
    await dispatchAction('deploy_confirm', '600', 'U-pm', basePayload(ts), async (t) => {
      replies.push(t);
    });
    assert.match(replies[0]!, /between 1 and 500/);
    assert.equal((await store().get(ts))!.state, 'await_rollout');
  } finally {
    stub.restore();
  }
});

test('dispatchAction: rollout_confirm from the wrong state is a no-op', async () => {
  setBaseEnv();
  const ts = nextTs();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: ts, channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    ); // stays 'received'
    const replies: string[] = [];
    await dispatchAction('rollout_confirm', '15', 'U-pm', basePayload(ts), async (t) => {
      replies.push(t);
    });
    assert.match(replies[0]!, /can't be queued/);
    assert.equal((await store().get(ts))!.state, 'received');
  } finally {
    stub.restore();
  }
});

test('dispatchAction: rollback_confirm zeroes the flag and ends the run', async () => {
  setBaseEnv();
  const ts = nextTs();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: ts, channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    );
    await store().update(ts, (r) => ({
      ...r,
      state: 'live',
      flag_key: 'feat_x',
      rollout_pct: 15,
    }));
    const replies: string[] = [];
    await dispatchAction('rollback_confirm', '', 'U-pm', basePayload(ts), async (t) => {
      replies.push(t);
    });
    const run = (await store().get(ts))!;
    assert.equal(run.state, 'rolled_back');
    assert.equal(run.rollout_pct, 0);
    assert.match(replies[0]!, /0%/);
  } finally {
    stub.restore();
  }
});

test('dispatchAction: unknown thread is reported, not crashed', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    const replies: string[] = [];
    await dispatchAction(
      'rollout_confirm',
      '15',
      'U-pm',
      basePayload('does.not.exist'),
      async (t) => {
        replies.push(t);
      },
    );
    assert.match(replies[0]!, /No run on this thread/);
  } finally {
    stub.restore();
  }
});

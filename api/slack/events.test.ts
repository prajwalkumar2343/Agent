import assert from 'node:assert/strict';
import test from 'node:test';

import handler, { routeEvent, specFor } from './events.ts';
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

test('slack events: url_verification answers the challenge', async () => {
  setBaseEnv();
  const res = fakeRes();
  await handler(
    fakeReq(JSON.stringify({ type: 'url_verification', challenge: 'ch-123' }), (() => {
      const s = slackSignature(JSON.stringify({ type: 'url_verification', challenge: 'ch-123' }));
      return { 'x-slack-request-timestamp': s.timestamp, 'x-slack-signature': s.signature };
    })()),
    res as never,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { challenge: 'ch-123' });
});

test('slack events: rejects bad signatures', async () => {
  setBaseEnv();
  const bad = fakeRes();
  await handler(
    fakeReq(JSON.stringify({ type: 'url_verification', challenge: 'x' }), {
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-slack-signature': 'v0=forged',
    }),
    bad as never,
  );
  assert.equal(bad.statusCode, 401);
});

test('slack events: wrong team gets 403', async () => {
  setBaseEnv();
  const raw = JSON.stringify({ type: 'event_callback', team_id: 'T-other', event_id: 'Ev1' });
  const { timestamp, signature } = slackSignature(raw);
  const res = fakeRes();
  await handler(
    fakeReq(raw, {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    }),
    res as never,
  );
  assert.equal(res.statusCode, 403);
});

test('slack events: mention runs intake → spec → checked → build and dispatches the workflow', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    await routeEvent({
      type: 'app_mention',
      channel: 'C-ideas',
      user: 'U-req',
      text: '<@UBOT> add usage-based billing alerts',
      ts: '1700.0001',
    });

    const run = await store().get('1700.0001');
    assert.ok(run, 'run was created');
    assert.equal(run.state, 'build');
    assert.equal(run.idea, 'add usage-based billing alerts');
    assert.equal(run.spec?.title, 'add usage-based billing alerts');
    assert.equal(run.flag_key, 'feat_add_usage_based_billing_alerts');
    assert.equal(run.feature_check, undefined);

    const posts = stub.jsonTo('slack.com/api/chat.postMessage') as {
      channel: string;
      text: string;
      thread_ts?: string;
    }[];
    assert.equal(posts.length, 3); // thread ack + spec card + building notice
    const toThread = posts.filter((p) => p.channel === 'C-ideas');
    const toPm = posts.filter((p) => p.channel === 'D-dm');
    assert.equal(toThread.length, 1);
    assert.match(toThread[0]!.text, /thanks for the feature request/i);
    assert.equal(toPm.length, 2);
    const dispatch = stub.to('api.github.com')[0];
    assert.ok(dispatch, 'workflow dispatch fired');
    assert.match(dispatch.url, /repos\/org\/platform\/actions\/workflows\/feature-run\.yml\/dispatches/);
    const inputs = (JSON.parse(dispatch.body) as { inputs: Record<string, string> }).inputs;
    assert.equal(inputs.thread_ts, '1700.0001');
    assert.equal(inputs.flag_key, 'feat_add_usage_based_billing_alerts');
    assert.equal(inputs.callback_url, 'https://app.test/api/runs/complete');
    assert.equal(JSON.parse(inputs.spec_json!).title, 'add usage-based billing alerts');
    assert.equal(JSON.parse(inputs.evidence_json!), null);
  } finally {
    stub.restore();
  }
});

test('slack events: an idea the feature index covers still builds (no already-exists check)', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    await routeEvent({
      type: 'app_mention',
      channel: 'C-ideas',
      user: 'U-req',
      text: '<@UBOT> add a comments tool',
      ts: '1700.0005',
    });

    const run = await store().get('1700.0005');
    assert.ok(run, 'run was created');
    assert.equal(run.state, 'build', 'no already-exists gate — every idea builds');

    const posts = stub.jsonTo('slack.com/api/chat.postMessage') as {
      channel: string;
      text: string;
    }[];
    const toThread = posts.filter((p) => p.channel === 'C-ideas');
    assert.doesNotMatch(toThread.at(-1)!.text, /already exists/i);
    assert.equal(stub.to('api.github.com').length, 1, 'build dispatched');
  } finally {
    stub.restore();
  }
});

test('slack events: intake denial replies politely and creates no run', async () => {
  setBaseEnv();
  process.env.INTAKE_USER_IDS = 'U-someone-else';
  const stub = installFetchStub();
  try {
    await routeEvent({
      type: 'app_mention',
      channel: 'C-ideas',
      user: 'U-req',
      text: '<@UBOT> build me a pony',
      ts: '1700.0002',
    });
    assert.equal(await store().get('1700.0002'), null);
    const posts = stub.jsonTo('chat.postMessage') as { text: string }[];
    assert.match(posts.at(-1)!.text, /Can't take that one/);
  } finally {
    stub.restore();
    delete process.env.INTAKE_USER_IDS;
  }
});

test('slack events: thread replies on a live run forward to rollout/parse', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: '1700.0010', channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    );
    await routeEvent({
      type: 'message',
      channel: 'C-ideas',
      user: 'U-pm',
      text: 'roll out to 20%',
      ts: '1700.0099',
      thread_ts: '1700.0010',
    });
    const fwd = stub.to('app.test/api/rollout/parse');
    assert.equal(fwd.length, 1);
    assert.equal(fwd[0]!.headers['x-run-secret'], 'run-secret');
    const body = JSON.parse(fwd[0]!.body) as Record<string, string>;
    assert.deepEqual(
      { thread_ts: body.thread_ts, channel: body.channel, user: body.user, text: body.text },
      { thread_ts: '1700.0010', channel: 'C-ideas', user: 'U-pm', text: 'roll out to 20%' },
    );
  } finally {
    stub.restore();
  }
});

test('slack events: a bare PM DM command targets the single eligible run', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    await store().create(
      newRun({ thread_ts: '1700.0020', channel: 'C-ideas', requester_id: 'U-req', idea: 'x' }),
    );
    await store().update('1700.0020', (r) => ({ ...r, state: 'await_rollout' }));
    await routeEvent({
      type: 'message',
      channel_type: 'im',
      channel: 'D-pm',
      user: 'U-pm',
      text: 'roll out to 15%',
      ts: '1700.0100',
    });
    const fwd = stub.jsonTo('app.test/api/rollout/parse') as { thread_ts: string }[];
    assert.equal(fwd.length, 1);
    assert.equal(fwd[0]!.thread_ts, '1700.0020');
  } finally {
    stub.restore();
  }
});

test('slack events: a duplicate Slack delivery does not double-run', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    const raw = JSON.stringify({
      type: 'event_callback',
      team_id: 'T-test',
      event_id: 'Ev-dup',
      event: {
        type: 'app_mention',
        channel: 'C-ideas',
        user: 'U-req',
        text: '<@UBOT> a referral leaderboard',
        ts: '1700.0030',
      },
    });
    const r1 = fakeRes();
    await handler(
      fakeReq(raw, (() => {
        const s = slackSignature(raw);
        return { 'x-slack-request-timestamp': s.timestamp, 'x-slack-signature': s.signature };
      })()),
      r1 as never,
    );
    assert.equal(r1.statusCode, 200);
    await waitFor(() => stub.to('api.github.com').length === 1);

    const postsBefore = stub.to('chat.postMessage').length;
    const r2 = fakeRes();
    await handler(
      fakeReq(raw, (() => {
        const s = slackSignature(raw);
        return { 'x-slack-request-timestamp': s.timestamp, 'x-slack-signature': s.signature };
      })()),
      r2 as never,
    );
    assert.equal(r2.statusCode, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stub.to('chat.postMessage').length, postsBefore);
    assert.equal(stub.to('api.github.com').length, 1);
  } finally {
    stub.restore();
  }
});

test('slack events: a bare mention asks for the idea and creates no run', async () => {
  setBaseEnv();
  const stub = installFetchStub();
  try {
    await routeEvent({
      type: 'app_mention',
      channel: 'C-ideas',
      user: 'U-req',
      text: '<@UBOT>',
      ts: '1700.0040',
    });
    assert.equal(await store().get('1700.0040'), null, 'no run for an empty idea');
    const posts = stub.jsonTo('chat.postMessage') as { text: string }[];
    assert.equal(posts.length, 1);
    assert.match(posts[0]!.text, /feature idea/i);
    assert.equal(stub.to('api.github.com').length, 0, 'no build dispatched');
  } finally {
    stub.restore();
  }
});

test('specFor mock drafts a deterministic spec without external services', async () => {
  setBaseEnv();
  const spec = await specFor('usage-based billing alerts');
  assert.equal(spec.slug, 'usage-based-billing-alerts');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRunStore } from './memory.ts';
import { createKvRunStore } from './kv.ts';
import {
  dueReports,
  newRun,
  RunExistsError,
  RunNotFoundError,
  scheduleReports,
  transitionRun,
  type RunStore,
} from './store.ts';
import type { Run } from '../../shared/src/index.ts';

/** Minimal in-memory Upstash REST fake: command path → {result}. */
function fakeKvFetch() {
  const data = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const calls: string[] = [];
  const fetchFn = async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const args = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
    calls.push(args.join(' '));
    const respond = (result: unknown) =>
      new Response(JSON.stringify({ result }), { status: 200 });
    switch (args[0]) {
      case 'get':
        return respond(data.get(args[1]!) ?? null);
      case 'set': {
        if (args[3] === 'NX' && data.has(args[1]!)) return respond(null);
        data.set(args[1]!, args[2]!);
        return respond('OK');
      }
      case 'sadd': {
        const set = sets.get(args[1]!) ?? new Set<string>();
        set.add(args[2]!);
        sets.set(args[1]!, set);
        return respond(1);
      }
      case 'smembers':
        return respond([...(sets.get(args[1]!) ?? [])]);
      default:
        return new Response(JSON.stringify({ error: `unknown command ${args[0]}` }), {
          status: 400,
        });
    }
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

const stores: [string, () => RunStore][] = [
  ['memory', () => createMemoryRunStore()],
  ['kv', () => createKvRunStore({ url: 'https://kv.example', token: 't', fetchFn: fakeKvFetch().fetchFn })],
];

for (const [name, make] of stores) {
  test(`${name}: create/get/update/list round-trip`, async () => {
    const store = make();
    const run = newRun({ thread_ts: '10.1', channel: 'C1', requester_id: 'U1', idea: 'dark mode' });
    await store.create(run);
    assert.equal((await store.get('10.1'))?.idea, 'dark mode');
    const next = await store.update('10.1', (r) => ({ ...r, idea: 'light mode' }));
    assert.equal(next.idea, 'light mode');
    assert.deepEqual((await store.list()).map((r) => r.thread_ts), ['10.1']);
    assert.equal(await store.get('missing'), null);
  });

  test(`${name}: create rejects a duplicate thread`, async () => {
    const store = make();
    const run = newRun({ thread_ts: '9.9', channel: 'C1', requester_id: 'U1' });
    await store.create(run);
    await assert.rejects(store.create(run), RunExistsError);
  });

  test(`${name}: update on a missing run throws`, async () => {
    const store = make();
    await assert.rejects(store.update('nope', (r) => r), RunNotFoundError);
  });

  test(`${name}: transitionRun enforces the state machine`, async () => {
    const store = make();
    await store.create(newRun({ thread_ts: '1.1', channel: 'C1', requester_id: 'U1' }));
    const run = await transitionRun(store, '1.1', 'spec');
    assert.equal(run.state, 'spec');
    await assert.rejects(transitionRun(store, '1.1', 'done'), /illegal run transition/);
  });
}

test('kv: issues documented REST commands', async () => {
  const fake = fakeKvFetch();
  const store = createKvRunStore({ url: 'https://kv.example/', token: 't', fetchFn: fake.fetchFn });
  await store.create(newRun({ thread_ts: '1.2', channel: 'C1', requester_id: 'U1' }));
  await store.list();
  assert.deepEqual(fake.calls.map((c) => c.split(' ')[0]), ['set', 'sadd', 'smembers', 'get']);
});

test('dueReports fires each schedule entry once', () => {
  const base = 1_000_000;
  const run: Run = {
    ...newRun({ thread_ts: '2.0', channel: 'C1', requester_id: 'U1', now: base }),
    state: 'live',
    report_schedule: scheduleReports(base + 1),
  };
  assert.deepEqual(dueReports(run, base), []);
  const due = dueReports(run, base + 13 * 3600e3);
  assert.equal(due.length, 1);
  run.fired_reports.push(...due);
  assert.deepEqual(dueReports(run, base + 13 * 3600e3), []);
  assert.equal(dueReports(run, base + 49 * 3600e3).length, 2);
});

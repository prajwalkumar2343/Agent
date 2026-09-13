import assert from 'node:assert/strict';
import test from 'node:test';

import handler from './users.ts';
import { createDeployStoreFromEnv } from '../../packages/deploy/src/index.ts';
import { createRunStoreFromEnv, newRun } from '../../packages/store/src/index.ts';
import { fakeReq, fakeRes, setBaseEnv } from '../_test/httpFake.ts';

/**
 * Endpoint tests run on the in-memory deploy store (no POSTGRES_URL) —
 * Postgres itself is covered by the package tests' fake queryable.
 * The env-factory singleton persists per test file, so each test uses its
 * own flag key.
 */
function cleanEnv(): void {
  setBaseEnv();
  for (const k of [
    'POSTGRES_URL',
    'DATABASE_URL',
    'POSTGRES_URL_NON_POOLING',
    'DEPLOY_ALLOW_SEED',
    'DEPLOY_MAX_USERS',
    'AGENT_PAUSED',
  ]) {
    delete process.env[k];
  }
}

const auth = { 'x-run-secret': 'run-secret' };
let seq = 0;
const flag = () => `feat_t${++seq}`;

test('deploy endpoint: requires the run secret', async () => {
  cleanEnv();
  const res = fakeRes();
  await handler(fakeReq(JSON.stringify({ flag_key: 'feat_x', users: 5 }), {}), res as never);
  assert.equal(res.statusCode, 401);
});

test('deploy endpoint: validates flag_key and users', async () => {
  cleanEnv();
  const badFlag = fakeRes();
  await handler(
    fakeReq(JSON.stringify({ flag_key: 'nope;drop', users: 5 }), auth),
    badFlag as never,
  );
  assert.equal(badFlag.statusCode, 400);

  const badUsers = fakeRes();
  await handler(
    fakeReq(JSON.stringify({ flag_key: flag(), users: -3 }), auth),
    badUsers as never,
  );
  assert.equal(badUsers.statusCode, 400);
});

test('deploy endpoint: users above DEPLOY_MAX_USERS is refused + audited', async () => {
  cleanEnv();
  process.env.DEPLOY_MAX_USERS = '10';
  const res = fakeRes();
  await handler(fakeReq(JSON.stringify({ flag_key: flag(), users: 20 }), auth), res as never);
  assert.equal(res.statusCode, 403);
  assert.match(String(res.body), /exceeds the automated cap/);
});

test('deploy endpoint: thread_ts binds flag_key to the run that owns it', async () => {
  cleanEnv();
  const ts = '1700.5000';
  await createRunStoreFromEnv().create(
    newRun({ thread_ts: ts, channel: 'C-ideas', requester_id: 'U-r', idea: 'x' }),
  );
  await createRunStoreFromEnv().update(ts, (r) => ({ ...r, flag_key: 'feat_owned' }));

  const res = fakeRes();
  await handler(
    fakeReq(JSON.stringify({ flag_key: flag(), users: 5, thread_ts: ts }), auth),
    res as never,
  );
  assert.equal(res.statusCode, 409);
  assert.match(String(res.body), /does not belong/);
});

test('deploy endpoint: seed requires DEPLOY_ALLOW_SEED, then deploy applies', async () => {
  cleanEnv();
  const fk = flag();

  const noSeed = fakeRes();
  await handler(
    fakeReq(JSON.stringify({ flag_key: fk, users: 5, seed: true }), auth),
    noSeed as never,
  );
  assert.equal(noSeed.statusCode, 403);

  process.env.DEPLOY_ALLOW_SEED = '1';
  const ok = fakeRes();
  await handler(
    fakeReq(JSON.stringify({ flag_key: fk, users: 5, seed: true }), auth),
    ok as never,
  );
  assert.equal(ok.statusCode, 200);
  const body = ok.body as { applied: number; cohort_size: number; total_users: number };
  assert.deepEqual(
    { applied: body.applied, cohort_size: body.cohort_size, total_users: body.total_users },
    { applied: 5, cohort_size: 5, total_users: 5 },
  );

  // GET status reflects the cohort
  const status = fakeRes();
  await handler(
    Object.assign(fakeReq('', auth), { method: 'GET', query: { flag_key: fk } }),
    status as never,
  );
  assert.equal(status.statusCode, 200);
  assert.equal((status.body as { cohort_size: number }).cohort_size, 5);

  // users=0 undeploys
  const off = fakeRes();
  await handler(fakeReq(JSON.stringify({ flag_key: fk, users: 0 }), auth), off as never);
  assert.equal(off.statusCode, 200);
  assert.equal((off.body as { removed: number }).removed, 5);
  assert.equal(await createDeployStoreFromEnv().cohortSize(fk), 0);
});

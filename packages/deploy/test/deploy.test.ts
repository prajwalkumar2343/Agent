import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFlagKey,
  createDeployStoreFromEnv,
  createMemoryDeployStore,
  createPgDeployStore,
  deployConfigured,
  deployConnectionString,
  deployTableConfig,
  sqlIdent,
  type PgQueryable,
} from '../src/index.ts';

/**
 * A stateful fake PgQueryable — simulates the tables and the handful of
 * query shapes the adapter issues, so the deploy contract is exercised
 * end-to-end without a live Postgres.
 */
function fakePg(seedUserIds: string[] = []) {
  const users: string[] = [...seedUserIds];
  const cohorts = new Map<string, Set<string>>();
  const events: unknown[][] = [];
  const queries: string[] = [];

  const queryable = {
    async query(text: string, params: unknown[] = []) {
      queries.push(text);
      if (/CREATE TABLE/i.test(text)) return { rows: [], rowCount: 0 };
      if (/generate_series/i.test(text)) {
        // seed insert — params[0] is the deficit
        const deficit = Number(params[0]);
        for (let i = 0; i < deficit; i++) users.push(`seed-x-${users.length}`);
        return { rows: [], rowCount: deficit };
      }
      if (/WITH picked AS/i.test(text)) {
        const [flagKey, n] = params as [string, number];
        const cohort = cohorts.get(flagKey) ?? new Set<string>();
        cohorts.set(flagKey, cohort);
        const deficit = Math.max(n - cohort.size, 0);
        let applied = 0;
        for (const id of users) {
          if (applied >= deficit) break;
          if (!cohort.has(id)) {
            cohort.add(id);
            applied++;
          }
        }
        return {
          rows: [{ applied, cohort_size: cohort.size, total_users: users.length }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO/i.test(text) && /actor/i.test(text)) {
        events.push(params);
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM/i.test(text)) {
        const flagKey = String(params[0]);
        const removed = cohorts.get(flagKey)?.size ?? 0;
        cohorts.delete(flagKey);
        return { rows: [], rowCount: removed };
      }
      if (/SELECT user_id FROM/i.test(text)) {
        const flagKey = String(params[0]);
        const rows = [...(cohorts.get(flagKey) ?? [])].map((user_id) => ({ user_id }));
        return { rows, rowCount: rows.length };
      }
      if (/count\(\*\)/i.test(text)) {
        if (params.length) {
          // cohort count — flag_key is the lone param
          return { rows: [{ n: cohorts.get(String(params[0]))?.size ?? 0 }], rowCount: 1 };
        }
        return { rows: [{ n: users.length }], rowCount: 1 };
      }
      throw new Error(`fake pg: unmatched query: ${text.slice(0, 80)}`);
    },
  };
  // The fake answers with concrete row shapes — the PgQueryable port is
  // generic, so the cast lives here at the boundary rather than per return.
  return { queryable: queryable as unknown as PgQueryable, users, cohorts, events, queries };
}

test('sqlIdent validates env-configured identifiers', () => {
  assert.equal(sqlIdent('users'), 'users');
  assert.equal(sqlIdent('public.feature_cohorts'), 'public.feature_cohorts');
  assert.throws(() => sqlIdent('users; drop table users'), /unsafe/);
  assert.throws(() => sqlIdent('user-id'), /unsafe/);
  assert.throws(() => sqlIdent('a.b.c'), /unsafe/);
});

test('assertFlagKey enforces the feat_* contract', () => {
  assert.doesNotThrow(() => assertFlagKey('feat_dark_mode'));
  assert.throws(() => assertFlagKey('feat_x;drop'), /invalid flag_key/);
  assert.throws(() => assertFlagKey('notafeature'), /invalid flag_key/);
});

test('memory store: deploy grows the cohort to exactly N, idempotently', async () => {
  const store = createMemoryDeployStore(['u1', 'u2', 'u3', 'u4', 'u5']);
  const r1 = await store.deploy('feat_x', 3, { thread_ts: 't1', actor: 'test' });
  assert.deepEqual(
    { requested: r1.requested, applied: r1.applied, cohort_size: r1.cohort_size, total_users: r1.total_users },
    { requested: 3, applied: 3, cohort_size: 3, total_users: 5 },
  );
  assert.deepEqual(await store.cohortMembers('feat_x'), ['u1', 'u2', 'u3']);

  const r2 = await store.deploy('feat_x', 3);
  assert.equal(r2.applied, 0);
  assert.equal(r2.cohort_size, 3);

  const r3 = await store.deploy('feat_x', 5);
  assert.equal(r3.applied, 2);
  assert.equal(r3.cohort_size, 5);

  // Requested beyond the user base deploys to everyone, honestly reported.
  const r4 = await store.deploy('feat_x', 100);
  assert.equal(r4.applied, 0);
  assert.equal(r4.cohort_size, 5);
});

test('memory store: undeploy clears the cohort; seed tops users up', async () => {
  const store = createMemoryDeployStore();
  const seed = await store.seedUsers(10);
  assert.deepEqual(seed, { created: 10, total: 10 });
  const again = await store.seedUsers(10);
  assert.equal(again.created, 0);

  await store.deploy('feat_y', 4);
  assert.equal(await store.cohortSize('feat_y'), 4);
  const out = await store.undeploy('feat_y');
  assert.equal(out.removed, 4);
  assert.equal(await store.cohortSize('feat_y'), 0);
});

test('pg store: deploy writes cohort rows and maps the result', async () => {
  const pg = fakePg(['u1', 'u2', 'u3']);
  const store = createPgDeployStore({ queryable: pg.queryable });
  const r = await store.deploy('feat_pg', 2, { thread_ts: 'w1.0', actor: 'pipeline' });
  assert.deepEqual(
    { applied: r.applied, cohort_size: r.cohort_size, total_users: r.total_users },
    { applied: 2, cohort_size: 2, total_users: 3 },
  );
  assert.deepEqual([...pg.cohorts.get('feat_pg')!], ['u1', 'u2']);
  // schema DDL ran (lazily, once) + a deploy event row was written
  assert.ok(pg.queries.some((q) => /CREATE TABLE IF NOT EXISTS feature_cohorts/i.test(q)));
  assert.ok(pg.queries.some((q) => /CREATE TABLE IF NOT EXISTS deploy_events/i.test(q)));
  assert.equal(pg.events.length, 1);

  const r2 = await store.deploy('feat_pg', 3);
  assert.equal(r2.applied, 1); // grew to exactly 3, not 3 more
  const out = await store.undeploy('feat_pg');
  assert.equal(out.removed, 3);
});

test('pg store: seedUsers fills the deficit only', async () => {
  const pg = fakePg(['real-1', 'real-2']);
  const store = createPgDeployStore({ queryable: pg.queryable });
  const s = await store.seedUsers(5);
  assert.deepEqual(s, { created: 3, total: 5 });
});

test('env factory: memory fallback without a URL, pg when configured', () => {
  const bare = {} as NodeJS.ProcessEnv;
  assert.equal(deployConnectionString(bare), undefined);
  assert.equal(deployConfigured(bare), false);
  assert.equal(
    deployConnectionString({ POSTGRES_URL: 'postgres://x' } as NodeJS.ProcessEnv),
    'postgres://x',
  );
  assert.equal(
    deployConnectionString({ DATABASE_URL: 'postgres://y' } as NodeJS.ProcessEnv),
    'postgres://y',
  );
  assert.ok(createDeployStoreFromEnv({} as NodeJS.ProcessEnv));
});

test('deployTableConfig reads env with safe defaults', () => {
  const def = deployTableConfig({} as NodeJS.ProcessEnv);
  assert.deepEqual(def, {
    usersTable: 'users',
    userIdColumn: 'id',
    usersOrder: 'id',
    cohortTable: 'feature_cohorts',
    eventsTable: 'deploy_events',
  });
  const custom = deployTableConfig({
    DEPLOY_USERS_TABLE: 'accounts',
    DEPLOY_USERS_ID_COLUMN: 'user_id',
    DEPLOY_COHORT_TABLE: 'flag_cohorts',
  } as NodeJS.ProcessEnv);
  assert.equal(custom.usersTable, 'accounts');
  assert.equal(custom.usersOrder, 'user_id'); // order defaults to the id column
  assert.throws(() =>
    deployTableConfig({ DEPLOY_USERS_TABLE: 'users;drop' } as NodeJS.ProcessEnv),
  );
});

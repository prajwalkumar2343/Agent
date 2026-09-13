import {
  assertFlagKey,
  sqlIdent,
  type DeployMeta,
  type DeployResult,
  type DeployStore,
  type DeployTableConfig,
  type SeedResult,
  type UndeployResult,
} from './deploy.ts';

/**
 * Minimal query surface over node-postgres — a Pool or anything shaped like
 * it. Tests inject a fake; production gets `pgQueryable(connectionString)`.
 */
export interface PgQueryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * Lazily-built pg.Pool — one per warm serverless instance. `pg` is imported
 * on first query so the memory fallback and tests never touch the driver.
 * SSL: off for localhost/sslmode=disable or POSTGRES_SSL=disable, otherwise
 * `rejectUnauthorized:false` (hosted Postgres — Neon, Supabase, RDS — uses
 * managed certs; pair with the pooled URL).
 */
export function pgQueryable(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): PgQueryable {
  let pool: PgQueryable | null = null;
  const useSsl = (() => {
    if ((env.POSTGRES_SSL ?? '').trim().toLowerCase() === 'disable') return false;
    try {
      const u = new URL(connectionString);
      if (u.searchParams.get('sslmode') === 'disable') return false;
      if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) return false;
    } catch {
      // Unparseable DSN — let pg raise the real error at connect time.
    }
    return true;
  })();
  return {
    async query(text, params) {
      if (!pool) {
        const { Pool } = await import('pg');
        pool = new Pool({
          connectionString,
          max: 4,
          ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        });
      }
      return pool.query(text, params);
    },
  };
}

export interface PgDeployStoreConfig extends Partial<DeployTableConfig> {
  queryable: PgQueryable;
}

/**
 * DeployStore over Postgres. All values are parameterized; the only
 * interpolated bits are env-configured identifiers run through sqlIdent.
 * Cohort/event DDL is created lazily once per store instance — the product's
 * users table is only ever read (or appended to by the demo-gated seed).
 */
export function createPgDeployStore(config: PgDeployStoreConfig): DeployStore {
  const users = sqlIdent(config.usersTable ?? 'users');
  const idCol = sqlIdent(config.userIdColumn ?? 'id');
  const orderCol = sqlIdent(config.usersOrder ?? config.userIdColumn ?? 'id');
  const cohort = sqlIdent(config.cohortTable ?? 'feature_cohorts');
  const events = sqlIdent(config.eventsTable ?? 'deploy_events');
  const { queryable } = config;

  let ready: Promise<void> | null = null;
  const ensureSchema = (): Promise<void> =>
    (ready ??= (async () => {
      await queryable.query(
        `CREATE TABLE IF NOT EXISTS ${cohort} (
           flag_key    text        NOT NULL,
           user_id     text        NOT NULL,
           thread_ts   text,
           actor       text,
           deployed_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY (flag_key, user_id)
         )`,
      );
      await queryable.query(
        `CREATE TABLE IF NOT EXISTS ${events} (
           id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           at        timestamptz NOT NULL DEFAULT now(),
           flag_key  text NOT NULL,
           action    text NOT NULL,
           requested int,
           applied   int,
           actor     text,
           thread_ts text
         )`,
      );
    })());

  /** Audit row — best-effort: a bookkeeping failure must not break deploys. */
  async function record(
    flagKey: string,
    action: string,
    requested: number | null,
    applied: number | null,
    meta?: DeployMeta,
  ): Promise<void> {
    try {
      await queryable.query(
        `INSERT INTO ${events} (flag_key, action, requested, applied, actor, thread_ts)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [flagKey, action, requested, applied, meta?.actor ?? null, meta?.thread_ts ?? null],
      );
    } catch (err) {
      console.error(
        `deploy: event write failed (${action} ${flagKey}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const count = async (text: string, params?: unknown[]): Promise<number> => {
    const r = await queryable.query<{ n: number | string }>(text, params);
    return Number(r.rows[0]?.n ?? 0);
  };

  return {
    ensureSchema,

    async totalUsers() {
      return count(`SELECT count(*)::int AS n FROM ${users}`);
    },

    async cohortSize(flagKey) {
      assertFlagKey(flagKey);
      await ensureSchema();
      return count(`SELECT count(*)::int AS n FROM ${cohort} WHERE flag_key = $1`, [flagKey]);
    },

    async cohortMembers(flagKey, limit = 1000) {
      assertFlagKey(flagKey);
      await ensureSchema();
      const r = await queryable.query<{ user_id: string }>(
        `SELECT user_id FROM ${cohort} WHERE flag_key = $1 ORDER BY deployed_at ASC LIMIT $2`,
        [flagKey, limit],
      );
      return r.rows.map((row) => row.user_id);
    },

    async deploy(flagKey, n, meta) {
      assertFlagKey(flagKey);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`deploy: users must be a positive integer, got ${n}`);
      }
      await ensureSchema();
      // First-N-minus-members keeps the cohort at exactly N across re-deploys:
      // ON CONFLICT alone can't grow the cohort when some picks are members
      // already, and deletions elsewhere can't shrink it below N silently.
      const r = await queryable.query<{
        applied: number | string;
        cohort_size: number | string;
        total_users: number | string;
      }>(
        `WITH picked AS (
           SELECT u.${idCol}::text AS user_id
           FROM ${users} u
           WHERE NOT EXISTS (
             SELECT 1 FROM ${cohort} c
             WHERE c.flag_key = $1 AND c.user_id = u.${idCol}::text
           )
           ORDER BY u.${orderCol}, u.${idCol}
           LIMIT GREATEST($2 - (SELECT count(*) FROM ${cohort} WHERE flag_key = $1), 0)
         ), ins AS (
           INSERT INTO ${cohort} (flag_key, user_id, thread_ts, actor)
           SELECT $1, picked.user_id, $3, $4 FROM picked
           ON CONFLICT (flag_key, user_id) DO NOTHING
           RETURNING user_id
         )
         SELECT (SELECT count(*) FROM ins)::int        AS applied,
                (SELECT count(*) FROM ${cohort}
                  WHERE flag_key = $1)::int            AS cohort_size,
                (SELECT count(*) FROM ${users})::int   AS total_users`,
        [flagKey, n, meta?.thread_ts ?? null, meta?.actor ?? null],
      );
      const row = r.rows[0];
      const result: DeployResult = {
        flag_key: flagKey,
        requested: n,
        applied: Number(row?.applied ?? 0),
        cohort_size: Number(row?.cohort_size ?? 0),
        total_users: Number(row?.total_users ?? 0),
      };
      await record(flagKey, 'deploy', n, result.applied, meta);
      return result;
    },

    async undeploy(flagKey, meta) {
      assertFlagKey(flagKey);
      await ensureSchema();
      const r = await queryable.query(`DELETE FROM ${cohort} WHERE flag_key = $1`, [flagKey]);
      const removed = r.rowCount ?? 0;
      await record(flagKey, 'undeploy', null, removed, meta);
      return { flag_key: flagKey, removed };
    },

    async seedUsers(count_) {
      if (!Number.isInteger(count_) || count_ <= 0) {
        throw new Error(`seedUsers: count must be a positive integer, got ${count_}`);
      }
      // The users table is the product's — create it only as a demo seed
      // (DEPLOY_ALLOW_SEED-gated at the endpoint), never as a side effect.
      await queryable.query(
        `CREATE TABLE IF NOT EXISTS ${users} (
           ${idCol} text PRIMARY KEY,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const have = await count(`SELECT count(*)::int AS n FROM ${users}`);
      const deficit = Math.max(count_ - have, 0);
      if (deficit === 0) return { created: 0, total: have };
      // Unique-per-call ids keep seeds collision-free and idempotent at the
      // count level; a product-shaped users table (non-text id, NOT NULL
      // columns) just fails honestly here.
      const tag = `seed-${Date.now().toString(36)}`;
      const r = await queryable.query(
        `INSERT INTO ${users} (${idCol})
         SELECT '${tag}-' || g.i FROM generate_series(1, $1) AS g(i)
         ON CONFLICT (${idCol}) DO NOTHING`,
        [deficit],
      );
      const created = r.rowCount ?? 0;
      await record('*', 'seed', count_, created, { actor: 'seed' });
      return { created, total: have + created };
    },
  };
}

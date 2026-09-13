/**
 * User-count deployments ("deploy to N users") — the Postgres-backed
 * counterpart to PostHog's percentage rollout. A deployment is a cohort:
 * `feature_cohorts(flag_key, user_id)` rows naming exactly which users the
 * feature is live for. The product app gates on membership
 * (`select exists(...)`); the pipeline owns writes.
 *
 * Cohort members are drawn from the product's users table — the first N by
 * the configured order column, deterministically, so a re-deploy of the same
 * N is a no-op and N' > N grows the cohort to exactly N' ("at least N"
 * semantics would leave the count fuzzy after deletions).
 */

export interface DeployMeta {
  /** Run that requested the deploy — audit trail. */
  thread_ts?: string;
  /** Who/what triggered it: 'pipeline', 'agent', `run:<ts>`, … */
  actor?: string;
}

export interface DeployResult {
  flag_key: string;
  /** Users requested this call. */
  requested: number;
  /** Newly inserted this call (0 on an idempotent re-deploy). */
  applied: number;
  /** Total members in the flag's cohort now. */
  cohort_size: number;
  /** Rows in the source users table — requested may exceed this. */
  total_users: number;
}

export interface UndeployResult {
  flag_key: string;
  removed: number;
}

export interface SeedResult {
  created: number;
  total: number;
}

export interface DeployStore {
  /** Create the cohort/event tables when missing. Idempotent; other methods call it lazily. */
  ensureSchema(): Promise<void>;
  /** Rows in the source users table. */
  totalUsers(): Promise<number>;
  cohortSize(flagKey: string): Promise<number>;
  cohortMembers(flagKey: string, limit?: number): Promise<string[]>;
  /**
   * Grow the flag's cohort to exactly `users` members — the first `users`
   * rows of the users table by order column, minus existing members.
   * Never removes members; `undeploy` is the only shrink path.
   */
  deploy(flagKey: string, users: number, meta?: DeployMeta): Promise<DeployResult>;
  /** Drop the flag's whole cohort — the rollback path. */
  undeploy(flagKey: string, meta?: DeployMeta): Promise<UndeployResult>;
  /**
   * Demo/dev affordance: ensure the users table holds at least `count`
   * synthetic rows. Callers gate this on DEPLOY_ALLOW_SEED (pg) — a real
   * product table must never be auto-populated.
   */
  seedUsers(count: number): Promise<SeedResult>;
}

/** Flag keys are `feat_<slug>` per docs/CONTRACTS.md — anything else is a bug or an attack. */
export const FLAG_KEY_RE = /^feat_[a-z0-9_]{1,43}$/;

export function assertFlagKey(flagKey: string): void {
  if (!FLAG_KEY_RE.test(flagKey)) {
    throw new Error(`invalid flag_key "${flagKey}" — expected feat_[a-z0-9_] (≤48 chars)`);
  }
}

/**
 * Table/column identifiers come from env config, never from request input —
 * but they still can't be parameterized in SQL, so they're validated here
 * and interpolated. `schema.table` qualifies allowed.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function sqlIdent(name: string): string {
  const parts = name.split('.');
  if (parts.length > 2 || parts.some((p) => !IDENT.test(p))) {
    throw new Error(`unsafe SQL identifier: "${name}"`);
  }
  return parts.join('.');
}

export interface DeployTableConfig {
  /** Product users table — the cohort's member source. Default `users`. */
  usersTable: string;
  /** Users PK column, cast to text into the cohort. Default `id`. */
  userIdColumn: string;
  /** Cohort pick order — earliest-first by default. Default: userIdColumn. */
  usersOrder: string;
  /** Cohort membership table. Default `feature_cohorts`. */
  cohortTable: string;
  /** Deploy/undeploy/seed audit table. Default `deploy_events`. */
  eventsTable: string;
}

export function deployTableConfig(env: NodeJS.ProcessEnv = process.env): DeployTableConfig {
  const usersTable = env.DEPLOY_USERS_TABLE?.trim() || 'users';
  const userIdColumn = env.DEPLOY_USERS_ID_COLUMN?.trim() || 'id';
  const cfg: DeployTableConfig = {
    usersTable,
    userIdColumn,
    usersOrder: env.DEPLOY_USERS_ORDER?.trim() || userIdColumn,
    cohortTable: env.DEPLOY_COHORT_TABLE?.trim() || 'feature_cohorts',
    eventsTable: env.DEPLOY_EVENTS_TABLE?.trim() || 'deploy_events',
  };
  // Validate now so a bad env value fails at startup/first call, not mid-SQL.
  sqlIdent(cfg.usersTable);
  sqlIdent(cfg.userIdColumn);
  sqlIdent(cfg.usersOrder);
  sqlIdent(cfg.cohortTable);
  sqlIdent(cfg.eventsTable);
  return cfg;
}

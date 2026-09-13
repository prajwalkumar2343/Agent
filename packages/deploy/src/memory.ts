import {
  assertFlagKey,
  type DeployMeta,
  type DeployResult,
  type DeployStore,
  type SeedResult,
  type UndeployResult,
} from './deploy.ts';

interface CohortEntry {
  thread_ts?: string;
  actor?: string;
  at: number;
}

/**
 * In-memory DeployStore — local dev, tests, and CI, same posture as the run
 * store: `createDeployStoreFromEnv` selects it only when no Postgres URL is
 * set. `seedUsers` is ungated here — a process-local fake can't hurt a real
 * users table (the DEPLOY_ALLOW_SEED check lives at the endpoint anyway).
 */
export function createMemoryDeployStore(seedUserIds: string[] = []): DeployStore {
  const users = new Set(seedUserIds);
  const cohorts = new Map<string, Map<string, CohortEntry>>();
  const events: Record<string, unknown>[] = [];

  const cohortOf = (flagKey: string): Map<string, CohortEntry> => {
    let c = cohorts.get(flagKey);
    if (!c) cohorts.set(flagKey, (c = new Map()));
    return c;
  };

  const record = (
    flagKey: string,
    action: string,
    requested: number | null,
    applied: number | null,
    meta?: DeployMeta,
  ): void => {
    events.push({
      at: Date.now(),
      flag_key: flagKey,
      action,
      requested,
      applied,
      actor: meta?.actor ?? null,
      thread_ts: meta?.thread_ts ?? null,
    });
  };

  return {
    async ensureSchema() {},

    async totalUsers() {
      return users.size;
    },

    async cohortSize(flagKey) {
      assertFlagKey(flagKey);
      return cohorts.get(flagKey)?.size ?? 0;
    },

    async cohortMembers(flagKey, limit = 1000) {
      assertFlagKey(flagKey);
      return [...(cohorts.get(flagKey)?.keys() ?? [])].slice(0, limit);
    },

    async deploy(flagKey, n, meta) {
      assertFlagKey(flagKey);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`deploy: users must be a positive integer, got ${n}`);
      }
      const cohort = cohortOf(flagKey);
      const deficit = Math.max(n - cohort.size, 0);
      let applied = 0;
      for (const id of users) {
        if (applied >= deficit) break;
        if (cohort.has(id)) continue;
        cohort.set(id, { thread_ts: meta?.thread_ts, actor: meta?.actor, at: Date.now() });
        applied++;
      }
      record(flagKey, 'deploy', n, applied, meta);
      const result: DeployResult = {
        flag_key: flagKey,
        requested: n,
        applied,
        cohort_size: cohort.size,
        total_users: users.size,
      };
      return result;
    },

    async undeploy(flagKey, meta) {
      assertFlagKey(flagKey);
      const removed = cohorts.get(flagKey)?.size ?? 0;
      cohorts.delete(flagKey);
      record(flagKey, 'undeploy', null, removed, meta);
      return { flag_key: flagKey, removed };
    },

    async seedUsers(count) {
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`seedUsers: count must be a positive integer, got ${count}`);
      }
      let created = 0;
      for (let i = users.size + 1; users.size < count; i++) {
        users.add(`user-${i}`);
        created++;
      }
      if (created) record('*', 'seed', count, created, { actor: 'seed' });
      return { created, total: users.size };
    },
  };
}

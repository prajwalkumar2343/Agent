import type { DeployStore } from './deploy.ts';
import { deployTableConfig } from './deploy.ts';
import { createMemoryDeployStore } from './memory.ts';
import { createPgDeployStore, pgQueryable } from './pg.ts';

export * from './deploy.ts';
export * from './pg.ts';
export * from './memory.ts';

let fallback: DeployStore | null = null;
let cached: { cs: string; store: DeployStore } | null = null;

/** The Postgres DSN the deploy store uses — Vercel Postgres sets POSTGRES_URL. */
export function deployConnectionString(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.POSTGRES_URL?.trim() ||
    env.DATABASE_URL?.trim() ||
    env.POSTGRES_URL_NON_POOLING?.trim() ||
    undefined
  );
}

export function deployConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(deployConnectionString(env));
}

/**
 * Postgres-backed store when POSTGRES_URL/DATABASE_URL is set, otherwise a
 * process-local memory store — fine for `vercel dev` and tests, visibly
 * wrong for production, so we warn once (same posture as the run store).
 */
export function createDeployStoreFromEnv(env: NodeJS.ProcessEnv = process.env): DeployStore {
  const cs = deployConnectionString(env);
  if (cs) {
    if (!cached || cached.cs !== cs) {
      cached = {
        cs,
        store: createPgDeployStore({
          queryable: pgQueryable(cs, env),
          ...deployTableConfig(env),
        }),
      };
    }
    return cached.store;
  }
  if (!fallback) {
    console.warn('deploy: no POSTGRES_URL/DATABASE_URL — using in-memory cohort store (dev only)');
    fallback = createMemoryDeployStore();
  }
  return fallback;
}

import type { Run } from '../../shared/src/index.ts';
import { RunExistsError, RunNotFoundError, type RunStore } from './store.ts';

/**
 * In-memory RunStore — local dev, tests, and CI. Warm serverless instances
 * keep it alive across invocations but MUST NOT be relied on in production;
 * `createRunStoreFromEnv` only selects it when KV env vars are absent.
 */
export function createMemoryRunStore(seed: Run[] = []): RunStore {
  const runs = new Map<string, Run>(seed.map((r) => [r.thread_ts, r]));
  return {
    async get(threadTs) {
      return runs.get(threadTs) ?? null;
    },
    async create(run) {
      if (runs.has(run.thread_ts)) throw new RunExistsError(run.thread_ts);
      runs.set(run.thread_ts, run);
      return run;
    },
    async update(threadTs, mutate) {
      const run = runs.get(threadTs);
      if (!run) throw new RunNotFoundError(threadTs);
      const next = mutate(run);
      runs.set(threadTs, next);
      return next;
    },
    async list() {
      return [...runs.values()];
    },
  };
}

import type { Run } from '../../shared/src/index.ts';
import { RunExistsError, RunNotFoundError, type RunStore } from './store.ts';

/**
 * In-memory RunStore — local dev, tests, and CI. Warm serverless instances
 * keep it alive across invocations but MUST NOT be relied on in production;
 * `createRunStoreFromEnv` only selects it when KV env vars are absent.
 * Runs are cloned on every boundary so callers can't mutate stored state
 * (or feed in objects the store would alias) outside update()/transitionRun.
 */
export function createMemoryRunStore(seed: Run[] = []): RunStore {
  const runs = new Map<string, Run>(seed.map((r) => [r.thread_ts, structuredClone(r)]));
  return {
    async get(threadTs) {
      const run = runs.get(threadTs);
      return run ? structuredClone(run) : null;
    },
    async create(run) {
      if (runs.has(run.thread_ts)) throw new RunExistsError(run.thread_ts);
      runs.set(run.thread_ts, structuredClone(run));
      return run;
    },
    async update(threadTs, mutate) {
      const run = runs.get(threadTs);
      if (!run) throw new RunNotFoundError(threadTs);
      const next = mutate(structuredClone(run));
      runs.set(threadTs, structuredClone(next));
      return next;
    },
    async list() {
      return [...runs.values()].map((run) => structuredClone(run));
    },
  };
}

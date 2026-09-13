import { createKvRunStore } from './kv.ts';
import { createMemoryRunStore } from './memory.ts';
import type { RunStore } from './store.ts';

export * from './machine.ts';
export * from './store.ts';
export * from './memory.ts';
export * from './kv.ts';

let fallback: RunStore | null = null;

/**
 * KV-backed store when KV_REST_API_URL/TOKEN are set (Vercel injects them),
 * otherwise a process-local memory store — fine for `vercel dev` and tests,
 * visibly wrong for production, so we warn once.
 */
export function createRunStoreFromEnv(env: NodeJS.ProcessEnv = process.env): RunStore {
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return createKvRunStore({ url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN });
  }
  if (!fallback) {
    console.warn('store: KV env vars absent, using in-memory run store (dev only)');
    fallback = createMemoryRunStore();
  }
  return fallback;
}

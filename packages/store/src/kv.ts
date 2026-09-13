import type { Run } from '../../shared/src/index.ts';
import { RunExistsError, RunNotFoundError, type RunStore } from './store.ts';

type FetchFn = typeof fetch;

export interface KvConfig {
  /** KV_REST_API_URL — Upstash-compatible REST base, no trailing slash needed. */
  url: string;
  /** KV_REST_API_TOKEN */
  token: string;
  /** Injectable for tests — no live KV needed. */
  fetchFn?: FetchFn;
}

const RUN_PREFIX = 'run:';
const INDEX_KEY = 'runs:index';

const runKey = (threadTs: string) => `${RUN_PREFIX}${threadTs}`;

/**
 * RunStore over Vercel KV / Upstash REST. Each run is one JSON document at
 * `run:<thread_ts>`; `runs:index` is a SET of thread_ts values for `list()`.
 * Single-command writes are atomic; create/update are read-modify-write
 * (see RunStore docs for the concurrency contract).
 */
export function createKvRunStore(config: KvConfig): RunStore {
  const url = config.url.replace(/\/+$/, '');
  const call = config.fetchFn ?? fetch;

  async function command<T>(...args: string[]): Promise<T> {
    const res = await call(`${url}/${args.map(encodeURIComponent).join('/')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}` },
    });
    const json = (await res.json()) as { result?: T; error?: string };
    if (!res.ok || json.error) {
      throw new Error(`kv ${args[0]} failed: ${json.error ?? res.status}`);
    }
    return json.result as T;
  }

  async function get(threadTs: string): Promise<Run | null> {
    const raw = await command<string | null>('get', runKey(threadTs));
    return raw ? (JSON.parse(raw) as Run) : null;
  }

  return {
    get,
    async create(run) {
      // SET NX gives us an atomic exists-check; the index add happens after
      // and is idempotent, so a crash mid-create leaves a harmless orphan doc.
      const res = await command<string | null>(
        'set',
        runKey(run.thread_ts),
        JSON.stringify(run),
        'NX',
      );
      if (res !== 'OK') throw new RunExistsError(run.thread_ts);
      await command('sadd', INDEX_KEY, run.thread_ts);
      return run;
    },
    async update(threadTs, mutate) {
      const run = await get(threadTs);
      if (!run) throw new RunNotFoundError(threadTs);
      const next = mutate(run);
      await command('set', runKey(threadTs), JSON.stringify(next));
      return next;
    },
    async list() {
      const ids = await command<string[]>('smembers', INDEX_KEY);
      const runs = await Promise.all(ids.map(get));
      return runs.filter((r): r is Run => r !== null);
    },
  };
}

/**
 * Minimal Upstash/Vercel-KV REST command helper for guard bookkeeping
 * (rate-limit counters, dedup markers, audit list). Separate from the run
 * store on purpose: guard keys are operational, not pipeline state.
 *
 * Returns null when KV isn't configured — callers fall back to memory.
 */

type FetchFn = typeof fetch;

let warned = false;

export function kvConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KV_REST_API_URL && env.KV_REST_API_TOKEN);
}

export async function kvCommand<T>(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchFn = fetch,
): Promise<T | null> {
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (!url || !token) {
    if (!warned) {
      warned = true;
      console.warn('guard: KV env vars absent — rate limits/dedup/audit degrade to in-memory only');
    }
    return null;
  }
  const res = await fetchFn(`${url.replace(/\/+$/, '')}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || json.error) throw new Error(`kv ${args[0]} failed: ${json.error ?? res.status}`);
  return json.result ?? null;
}

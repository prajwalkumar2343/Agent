import { kvCommand } from './kv.ts';

const AUDIT_KEY = 'guard:audit';
const AUDIT_CAP = 5_000;

/**
 * Append-only audit trail. Every safeguard decision — intake accepted/
 * rejected, merge gate verdicts, rollout actions, kill-switch hits — lands
 * here as a JSON line on stdout (Vercel/Actions logs) plus a capped KV list
 * for API-side review. Fire-and-forget: audit must never break the pipeline.
 */
export async function audit(event: string, data: Record<string, unknown> = {}): Promise<void> {
  const entry = JSON.stringify({ audit: event, at: Date.now(), ...data });
  console.log(entry);
  try {
    await kvCommand(['lpush', AUDIT_KEY, entry]);
    await kvCommand(['ltrim', AUDIT_KEY, '0', String(AUDIT_CAP - 1)]);
  } catch (err) {
    console.error('audit kv write failed:', err instanceof Error ? err.message : err);
  }
}

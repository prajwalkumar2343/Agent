import type { PostHogMcp } from './mcp.ts';

export interface FlagGroup {
  properties?: unknown[];
  rollout_percentage?: number | null;
  variant?: string | null;
  [k: string]: unknown;
}

export interface FeatureFlag {
  id: number;
  key: string;
  name?: string;
  active?: boolean;
  filters?: { groups?: FlagGroup[]; [k: string]: unknown };
  [k: string]: unknown;
}

/** PostHog tools answer in a few shapes — a flag, a {results: [...]} page, or a bare array. */
function asFlags(payload: unknown): FeatureFlag[] {
  if (Array.isArray(payload)) return payload as FeatureFlag[];
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const k of ['results', 'flags', 'feature_flags']) {
      if (Array.isArray(o[k])) return o[k] as FeatureFlag[];
    }
    if (typeof o.key === 'string') return [o as unknown as FeatureFlag];
  }
  return [];
}

/**
 * Only "flag missing" or "resolver tool unavailable" may fall back to the
 * list search — auth failures, 5xx and network errors must surface. A bare
 * "not found" isn't enough on its own: the message has to name the flag,
 * the tool or the method, or carry a real 404 status.
 */
function isFlagLookupMiss(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') return status === 404;
  const msg = err instanceof Error ? err.message : String(err);
  const notFound = /\b404\b|not[ _-]?found|no such|does not exist|could not find|cannot find/i.test(msg);
  const context = /flag|tool|method/i.test(msg);
  const resolver = /unknown (tool|method)|method not found|no .{0,20}(flag|tool)\b/i.test(msg);
  return (notFound && context) || resolver;
}

/**
 * Resolve a flag by its stable key (`feat_*`). Flag keys are derived
 * deterministically (see flagKeyFor in shared) so this is the only lookup the
 * pipeline needs. Prefers the by-key resolver (≤5 candidates), falls back to
 * the list endpoint's search.
 */
export async function findFlagByKey(client: PostHogMcp, key: string): Promise<FeatureFlag | null> {
  let candidates: FeatureFlag[] = [];
  try {
    candidates = asFlags(await client.callTool('feature-flag-get-definition-by-key', { key }));
  } catch (err) {
    if (!isFlagLookupMiss(err)) throw err;
    // flag missing or resolver unavailable — the list search below still covers us
  }
  let flag = candidates.find((f) => f.key === key);
  if (!flag) {
    flag = asFlags(await client.callTool('feature-flag-get-all', { search: key })).find(
      (f) => f.key === key,
    );
  }
  return flag ?? null;
}

/**
 * Set a flag's rollout percentage — the one mutation the pipeline performs
 * (rollout to pct on merge, 0 on rollback). update-feature-flag replaces
 * `filters` wholesale, so the flag's existing groups are patched in place:
 * every group gets the same pct, targeting properties stay untouched. A pct
 * above 0 also activates the flag (new flags are created inactive); a
 * rollback to 0 leaves `active` alone — a 0% flag already evaluates false
 * for everyone without being disabled.
 */
export async function setRolloutPercentage(
  client: PostHogMcp,
  flag: FeatureFlag,
  pct: number,
): Promise<void> {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    throw new Error(`invalid rollout percentage: ${pct}`);
  }
  const groups = flag.filters?.groups?.length
    ? flag.filters.groups
    : [{ properties: [] }];
  const patched = groups.map((g) => ({ ...g, rollout_percentage: pct }));
  await client.callTool('update-feature-flag', {
    id: flag.id,
    filters: { ...(flag.filters ?? {}), groups: patched },
    ...(pct > 0 ? { active: true } : {}),
  });
}

/**
 * Create the flag when it's missing — called so the pipeline never reaches
 * rollout with a flag that doesn't exist. New flags start inactive at 0%.
 */
export async function ensureFeatureFlag(
  client: PostHogMcp,
  key: string,
  name = key,
): Promise<{ flag: FeatureFlag; created: boolean }> {
  const existing = await findFlagByKey(client, key);
  if (existing) return { flag: existing, created: false };
  const created = asFlags(
    await client.callTool('create-feature-flag', {
      key,
      name,
      active: false,
      filters: { groups: [{ properties: [], rollout_percentage: 0 }] },
    }),
  )[0];
  if (!created) {
    throw new Error(`create-feature-flag returned no flag for "${key}"`);
  }
  return { flag: created, created: true };
}

import type { PostHogClient } from './client.ts';

interface FeatureFlag {
  id: number;
  key: string;
  rollout_percentage: number | null;
}

/**
 * Resolve a flag's numeric id from its stable key (`feat_*`). Flag keys are
 * derived deterministically (see flagKeyFor in shared) so this is the only
 * lookup the pipeline needs.
 */
export async function findFlagByKey(client: PostHogClient, key: string): Promise<FeatureFlag | null> {
  const res = await client.api<{ results: FeatureFlag[] }>(
    `feature_flags/?search=${encodeURIComponent(key)}`,
  );
  return res.results.find((f) => f.key === key) ?? null;
}

/**
 * Set a flag's rollout percentage — the one mutation the pipeline performs
 * (rollout to pct on merge, 0 on rollback). Filters/cohorts stay untouched.
 */
export async function setRolloutPercentage(
  client: PostHogClient,
  flagId: number,
  pct: number,
): Promise<void> {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    throw new Error(`invalid rollout percentage: ${pct}`);
  }
  await client.api(`feature_flags/${flagId}/`, {
    method: 'PATCH',
    body: { rollout_percentage: pct },
  });
}

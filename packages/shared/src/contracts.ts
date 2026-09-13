import type { SimReport } from './types.ts';

export const RUN_COMPLETE_SECRET_HEADER = 'x-run-secret';

export interface RunsCompletePayload {
  thread_ts: string;
  status: 'success' | 'failed';
  pr_url?: string;
  pr_number?: number;
  branch?: string;
  sim_report?: SimReport;
  log_url?: string;
}

export interface FeatureRunInputs {
  thread_ts: string;
  spec_json: string;
  feature_context_json: string;
  evidence_json: string;
  flag_key: string;
  callback_url: string;
}

/**
 * POST /api/deploy/users — internal (x-run-secret). `users` = target cohort
 * size (0 undeploys); `seed` asks the app to top up demo users first (only
 * honored with DEPLOY_ALLOW_SEED=1). `thread_ts` binds the call to a run —
 * when the run exists its flag_key must match.
 */
export interface DeployUsersPayload {
  flag_key: string;
  users: number;
  thread_ts?: string;
  seed?: boolean;
}

export const ACTION = {
  ROLLOUT_CONFIRM: 'rollout_confirm',
  ROLLOUT_CANCEL: 'rollout_cancel',
  ROLLBACK_CONFIRM: 'rollback_confirm',
  /** User-count deploy (Postgres cohort) — button value carries the count. */
  DEPLOY_CONFIRM: 'deploy_confirm',
} as const;
export type ActionId = (typeof ACTION)[keyof typeof ACTION];

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function flagKeyFor(slug: string): string {
  const key = slugify(slug).replace(/-/g, '_');
  if (!key) throw new Error(`cannot build flag key from slug: ${slug}`);
  return `feat_${key}`.slice(0, 48);
}

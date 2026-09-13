import type { SimReport } from './types';

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

export const ACTION = {
  ROLLOUT_CONFIRM: 'rollout_confirm',
  ROLLOUT_CANCEL: 'rollout_cancel',
  ROLLBACK_CONFIRM: 'rollback_confirm',
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
  return `feat_${slugify(slug).replace(/-/g, '_')}`.slice(0, 48);
}

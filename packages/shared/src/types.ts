import type { RunState } from './states.ts';

export interface Spec {
  title: string;
  slug: string;
  summary: string;
  acceptance: string[];
}

export interface FeatureCheck {
  exists: boolean;
  confidence: number;
  reason: string;
  docs: { searched: boolean; pages: string[]; hits: string[] };
  events: { searched: boolean; matched: string[] };
  /**
   * Shipped-feature index (features.md) — the authoritative "already exists"
   * signal. Optional: runs stored before the index existed don't have it.
   */
  index?: { searched: boolean; hits: string[] };
}

export interface Evidence {
  summary: string;
  related_events: { name: string; count_30d: number }[];
  recordings_reviewed: number;
  notable_sessions: string[];
}

export interface SimReport {
  verdict: 'ship' | 'iterate' | 'drop';
  confidence: number;
  summary: string;
  persona_reactions: { persona: string; reaction: string; sentiment: -1 | 0 | 1 }[];
  evidence_links: string[];
}

export interface Run {
  thread_ts: string;
  channel: string;
  requester_id: string;
  pm_id: string;
  state: RunState;
  idea: string;
  spec?: Spec;
  feature_check?: FeatureCheck;
  evidence?: Evidence;
  workflow_run_id?: number;
  flag_key?: string;
  flag_id?: number;
  branch?: string;
  pr_url?: string;
  pr_number?: number;
  sim_report?: SimReport;
  /** Exactly one of pct (PostHog % rollout) / users (Postgres cohort) is set. */
  pending_rollout?: { pct?: number; users?: number; confirmed_by: string };
  rollout_pct?: number;
  /** Postgres cohort size once a user-count deploy lands (see packages/deploy). */
  rollout_users?: number;
  report_schedule: number[];
  fired_reports: number[];
  created_at: number;
  updated_at: number;
}

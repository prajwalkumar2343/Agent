import type { Run, RunState } from '../../shared/src/index.ts';
import { advance } from './machine.ts';

/**
 * Run persistence port. One `Run` JSON document per Slack thread, keyed by
 * `run:<thread_ts>` (payloads in docs/CONTRACTS.md identify runs by thread_ts
 * alone). Implementations keep a `runs:index` member set for the cron sweep.
 *
 * Concurrency: read-modify-write, last-write-wins. One run per thread and
 * human-paced transitions make lost updates unlikely; if a workstream needs
 * stronger guarantees, add versioned CAS inside the KV adapter — do not
 * change this interface.
 */
export interface RunStore {
  get(threadTs: string): Promise<Run | null>;
  /** Throws if a run already exists for the thread. */
  create(run: Run): Promise<Run>;
  /** Read-modify-write. Throws if the run does not exist. */
  update(threadTs: string, mutate: (run: Run) => Run): Promise<Run>;
  /** All indexed runs — small scale; the sweep scans this. */
  list(): Promise<Run[]>;
}

export class RunNotFoundError extends Error {
  readonly threadTs: string;
  constructor(threadTs: string) {
    super(`no run for thread_ts ${threadTs}`);
    this.name = 'RunNotFoundError';
    this.threadTs = threadTs;
  }
}

export class RunExistsError extends Error {
  readonly threadTs: string;
  constructor(threadTs: string) {
    super(`run already exists for thread_ts ${threadTs}`);
    this.name = 'RunExistsError';
    this.threadTs = threadTs;
  }
}

export function newRun(init: {
  thread_ts: string;
  channel: string;
  requester_id: string;
  pm_id?: string;
  idea?: string;
  now?: number;
}): Run {
  const now = init.now ?? Date.now();
  return {
    thread_ts: init.thread_ts,
    channel: init.channel,
    requester_id: init.requester_id,
    pm_id: init.pm_id ?? '',
    state: 'received',
    idea: init.idea ?? '',
    report_schedule: [],
    fired_reports: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Transition a persisted run. `patch` merges into the run alongside the new
 * state (e.g. `{ pr_url, sim_report }` on build completion).
 */
export function transitionRun(
  store: RunStore,
  threadTs: string,
  to: RunState,
  patch: Partial<Run> = {},
): Promise<Run> {
  return store.update(threadTs, (run) => advance(run, to, patch));
}

/**
 * Report scheduling. `report_schedule` holds absolute epoch-ms fire times —
 * set it at rollout (`scheduleReports(Date.now())`) so later `updated_at`
 * bumps can't shift the cadence. `fired_reports` stores the entries sent.
 */
export const REPORT_OFFSETS_MS = [12 * 3600e3, 24 * 3600e3, 48 * 3600e3] as const;

export function scheduleReports(fromMs: number): number[] {
  return REPORT_OFFSETS_MS.map((off) => fromMs + off);
}

export function dueReports(run: Run, now = Date.now()): number[] {
  return run.report_schedule.filter((t) => t <= now && !run.fired_reports.includes(t));
}

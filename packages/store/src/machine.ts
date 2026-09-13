import type { Run, RunState } from '../../shared/src/index.ts';

/**
 * Legal run-state edges, mirroring docs/CONTRACTS.md:
 *
 *   received → spec → checked → evidence → build → reported
 *     → await_rollout → await_ci → live → monitor → done
 *                        ↺ CI red    ↘ rolled_back   ↘ failed (any state)
 *
 * `checked → build` is the exists=false shortcut (skip evidence).
 * `await_ci → await_rollout` is the CI-red path (PM asked to iterate).
 */
const EDGES: Record<RunState, RunState[]> = {
  received: ['spec'],
  spec: ['checked'],
  checked: ['evidence', 'build'],
  evidence: ['build'],
  build: ['reported'],
  reported: ['await_rollout'],
  await_rollout: ['await_ci'],
  await_ci: ['live', 'await_rollout'],
  live: ['monitor', 'rolled_back'],
  monitor: ['done', 'rolled_back'],
  done: [],
  rolled_back: [],
  failed: [],
};

const TERMINAL: ReadonlySet<RunState> = new Set(['done', 'rolled_back', 'failed']);

export function canTransition(from: RunState, to: RunState): boolean {
  return to === 'failed' || EDGES[from].includes(to);
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL.has(state);
}

export class IllegalTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;
  constructor(from: RunState, to: RunState) {
    super(`illegal run transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * Apply a legal transition to an in-memory run. Stamps `updated_at`.
 * Throws IllegalTransitionError on a bad edge — callers in api/ should
 * translate that to 409.
 */
export function advance(run: Run, to: RunState, patch: Partial<Run> = {}, now = Date.now()): Run {
  assertTransition(run.state, to);
  return { ...run, ...patch, state: to, updated_at: now };
}

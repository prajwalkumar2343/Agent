import { agentBranchPrefix } from './policy.ts';

/**
 * Branch invariants. The github agent's tools call assertAgentBranch() at
 * construction so a caller bug or manipulated context fails fast — a run
 * can only ever create/commit/open-PR on `agent/*` branches, never on the
 * base branch (main) or any other protected ref.
 */

const PROTECTED = new Set(['main', 'master', 'trunk', 'develop', 'release', 'production']);

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED.has(branch) || branch.startsWith('release/');
}

export function assertAgentBranch(branch: string, base: string): void {
  const prefix = agentBranchPrefix();
  if (!branch.startsWith(prefix)) {
    throw new Error(`refusing to operate on non-${prefix} branch: ${branch}`);
  }
  if (branch === base || isProtectedBranch(branch)) {
    throw new Error(`refusing to operate on protected branch: ${branch}`);
  }
  if (branch.includes('..') || branch.includes(' ') || !/^[\w/.-]+$/.test(branch)) {
    throw new Error(`malformed branch name: ${branch}`);
  }
}

/** PR URLs handed back by the runner callback must point at the product repo. */
export function isExpectedPrUrl(url: string, repo: string): boolean {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^https://github\\.com/${escaped}/pull/\\d+$`).test(url);
}

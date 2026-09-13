import { requireEnv } from '../../packages/shared/src/index.ts';

/**
 * Minimal GitHub REST adapter scoped to what the pipeline needs — check-runs
 * for a commit and PR merge. Auth is the fine-grained PAT (docs/ENV.md).
 */

async function gh<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${requireEnv('GH_AGENT_PAT')}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) throw new Error(`github ${init.method ?? 'GET'} ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

const repo = () => requireEnv('PRODUCT_REPO');

interface CheckRunsResponse {
  check_runs: { name: string; status: string; conclusion: string | null }[];
}

/**
 * True only when every check-run on the sha completed successfully.
 * `skipped`/`neutral` count as green (GitHub treats them as passing).
 */
export async function checksGreen(sha: string): Promise<boolean> {
  const res = await gh<CheckRunsResponse>(`/repos/${repo()}/commits/${sha}/check-runs`);
  if (res.check_runs.length === 0) return false;
  return res.check_runs.every(
    (c) => c.status === 'completed' && (c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral'),
  );
}

export async function mergePr(prNumber: number, sha: string): Promise<void> {
  await gh(`/repos/${repo()}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: { merge_method: 'squash', sha },
  });
}

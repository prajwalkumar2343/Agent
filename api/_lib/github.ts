import { requireEnv, type FeatureRunInputs } from '../../packages/shared/src/index.ts';

/**
 * Minimal GitHub REST adapter scoped to what the pipeline needs — check-runs
 * for a commit, PR merge, and the feature-run workflow_dispatch. Auth is the
 * fine-grained PAT (docs/ENV.md).
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
  if (res.status === 204) return undefined as T;
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

export interface PrFile {
  filename: string;
  status: string;
  /** Per-file unified diff (absent on huge/binary files). */
  patch?: string;
}

/** List a PR's changed files — up to 3 pages × 100 for the merge gate. */
export async function prFiles(prNumber: number): Promise<PrFile[]> {
  const files: PrFile[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh<PrFile[]>(
      `/repos/${repo()}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

/**
 * Kick off .github/workflows/feature-run.yml on the platform repo when a run
 * enters `build`. Input contract: docs/CONTRACTS.md. The dispatch endpoint
 * answers 204 with no body — the run's workflow_run_id stays unset (the
 * callback identifies the run by thread_ts anyway).
 */
export function dispatchFeatureRun(inputs: FeatureRunInputs): Promise<void> {
  return gh(`/repos/${requireEnv('PLATFORM_REPO')}/actions/workflows/feature-run.yml/dispatches`, {
    method: 'POST',
    body: { ref: process.env.PLATFORM_REF ?? 'main', inputs },
  });
}

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const MAX_LIST = 500;
const MAX_READ_CHARS = 100_000;

export interface GithubToolsContext {
  /** owner/name of the product repo. */
  repo: string;
  /** Fine-grained PAT — stays inside tool implementations, never in model context. */
  token: string;
  /** Feature branch name (fixed by the caller — not model-chosen). */
  branch: string;
  /** Base branch, e.g. main. */
  base: string;
  /** Local checkout the coding agent worked in; commitChanges diffs it. */
  repoDir: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

type Fetch = typeof fetch;

/**
 * GitHub REST tools for the secondary agent. Deterministic inputs (repo,
 * branch, base) come from the context — the model only supplies content
 * (commit message, PR title/body). The multi-call Git Data choreography
 * (blobs → tree → commit → ref) lives here, not in model discipline.
 */
export function githubTools(ctx: GithubToolsContext): ToolSet {
  const call: Fetch = ctx.fetchFn ?? fetch;

  async function gh<T>(p: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await call(`https://api.github.com/repos/${ctx.repo}/${p.replace(/^\/+/, '')}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = new Error(`GitHub ${init?.method ?? 'GET'} ${p} → ${res.status}: ${data.message ?? 'unknown'}`) as Error & {
        status: number;
        data: unknown;
      };
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data as T;
  }

  async function refSha(ref: string): Promise<string> {
    const r = await gh<{ object: { sha: string } }>(`git/ref/heads/${ref}`);
    return r.object.sha;
  }

  async function changedFiles(): Promise<
    { path: string; deleted: boolean }[]
  > {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: ctx.repoDir,
    });
    const files: { path: string; deleted: boolean }[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      let p = line.slice(3).trim();
      if (p.includes(' -> ')) p = p.split(' -> ')[1]!;
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      files.push({ path: p, deleted: status.includes('D') });
    }
    return files;
  }

  return {
    createBranch: tool({
      description:
        `Create remote branch ${ctx.branch} from ${ctx.base}. Idempotent — if the ` +
        'branch already exists, reports that instead of failing.',
      inputSchema: z.object({}),
      execute: async () => {
        const baseSha = await refSha(ctx.base);
        try {
          await gh(`git/refs`, {
            method: 'POST',
            body: { ref: `refs/heads/${ctx.branch}`, sha: baseSha },
          });
          return { branch: ctx.branch, created: true, sha: baseSha };
        } catch (e) {
          if ((e as { status?: number }).status === 422) {
            return { branch: ctx.branch, created: false, note: 'branch already exists — commit onto it' };
          }
          throw e;
        }
      },
    }),

    commitChanges: tool({
      description:
        'Commit every local change in the working tree (modified, new, deleted ' +
        'files — collected via git status) onto the remote branch in a single ' +
        'commit. Call createBranch first.',
      inputSchema: z.object({
        message: z.string().describe('Commit message'),
      }),
      execute: async ({ message }) => {
        const files = await changedFiles();
        if (!files.length) return { committed: false, note: 'working tree is clean' };

        const headSha = await refSha(ctx.branch);
        const head = await gh<{ tree: { sha: string } }>(`git/commits/${headSha}`);

        const tree = await Promise.all(
          files.map(async (f) => {
            if (f.deleted) {
              return { path: f.path, mode: '100644' as const, type: 'blob' as const, sha: null };
            }
            const content = await readFile(path.join(ctx.repoDir, f.path), 'utf8');
            const blob = await gh<{ sha: string }>(`git/blobs`, {
              method: 'POST',
              body: { content, encoding: 'utf-8' },
            });
            return { path: f.path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha };
          }),
        );

        const newTree = await gh<{ sha: string }>(`git/trees`, {
          method: 'POST',
          body: { base_tree: head.tree.sha, tree },
        });
        const commit = await gh<{ sha: string }>(`git/commits`, {
          method: 'POST',
          body: { message, tree: newTree.sha, parents: [headSha] },
        });
        await gh(`git/refs/heads/${ctx.branch}`, {
          method: 'PATCH',
          body: { sha: commit.sha },
        });
        return { committed: true, sha: commit.sha, files: files.map((f) => f.path) };
      },
    }),

    openPR: tool({
      description:
        `Open a pull request from ${ctx.branch} into ${ctx.base}. If a PR for ` +
        'the branch already exists, returns the existing one.',
      inputSchema: z.object({
        title: z.string().max(120),
        body: z.string(),
      }),
      execute: async ({ title, body }) => {
        try {
          const pr = await gh<{ html_url: string; number: number }>(`pulls`, {
            method: 'POST',
            body: { title, body, head: ctx.branch, base: ctx.base },
          });
          return { pr_url: pr.html_url, pr_number: pr.number, created: true };
        } catch (e) {
          if ((e as { status?: number }).status !== 422) throw e;
          const owner = ctx.repo.split('/')[0];
          const existing = await gh<{ html_url: string; number: number }[]>(
            `pulls?state=open&head=${owner}:${ctx.branch}`,
          );
          if (existing[0]) {
            return { pr_url: existing[0].html_url, pr_number: existing[0].number, created: false };
          }
          throw e;
        }
      },
    }),

    readRemoteFile: tool({
      description:
        'Read a file from the remote repo at a ref (default: the feature ' +
        'branch). UTF-8 text only, capped at 100KB.',
      inputSchema: z.object({
        path: z.string(),
        ref: z.string().optional().describe('branch/sha; default the feature branch'),
      }),
      execute: async ({ path: p, ref }) => {
        const r = await gh<{ content?: string; encoding?: string; type?: string }>(
          `contents/${p.replace(/^\/+/, '')}?ref=${encodeURIComponent(ref ?? ctx.branch)}`,
        );
        if (r.type !== 'file' || !r.content) {
          return { error: `not a file (or >1MB, use git locally): ${p}` };
        }
        const text = Buffer.from(r.content, 'base64').toString('utf8');
        return { path: p, content: text.slice(0, MAX_READ_CHARS) };
      },
    }),

    listRemoteFiles: tool({
      description:
        `List remote file paths on ${ctx.base} via the git trees API. ` +
        'Truncates at 500 entries (API hard limit is 100k).',
      inputSchema: z.object({
        prefix: z.string().optional().describe('only paths starting with this prefix'),
        ref: z.string().optional(),
      }),
      execute: async ({ prefix, ref }) => {
        const r = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(
          `git/trees/${encodeURIComponent(ref ?? ctx.base)}?recursive=1`,
        );
        const files = r.tree
          .filter((t) => t.type === 'blob' && (!prefix || t.path.startsWith(prefix)))
          .map((t) => t.path)
          .slice(0, MAX_LIST);
        return { files, api_truncated: r.truncated, capped: files.length >= MAX_LIST };
      },
    }),
  };
}

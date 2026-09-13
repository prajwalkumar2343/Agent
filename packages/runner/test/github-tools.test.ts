import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ToolSet } from 'ai';
import { githubTools, type GithubToolsContext } from '../src/tools/github.ts';

const OPTS = { toolCallId: 't1', messages: [] };

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** Mock fetch: routes by method+path suffix, records calls, canned replies. */
function mockGithub(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: unknown, init?: { method?: string; body?: string; headers?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    const pathPart = url.split('api.github.com/')[1]!;
    for (const [key, value] of Object.entries(routes)) {
      const [m, suffix] = key.split(' ', 2) as [string, string];
      if (m === method && pathPart.endsWith(suffix)) {
        const status = (value as { __status?: number }).__status;
        return new Response(JSON.stringify(value), { status: status ?? 200 });
      }
    }
    return new Response(JSON.stringify({ message: `no route: ${method} ${pathPart}` }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function ctx(fetchFn: typeof fetch, repoDir = '/tmp/x'): GithubToolsContext {
  return { repo: 'o/r', token: 'tok', branch: 'agent/feat-1.2', base: 'main', repoDir, fetchFn };
}

async function exec(tools: ToolSet, name: string, input: unknown) {
  const t = tools[name]!;
  assert.ok(t.execute);
  return t.execute(input as never, OPTS);
}

describe('github tools', () => {
  it('createBranch posts a ref from the base sha', async () => {
    const { calls, fetchFn } = mockGithub({
      'GET git/ref/heads/main': { object: { sha: 'base123' } },
      'POST git/refs': { ref: 'refs/heads/agent/feat-1.2' },
    });
    const res = (await exec(githubTools(ctx(fetchFn)), 'createBranch', {})) as {
      created: boolean;
      sha: string;
    };
    assert.equal(res.created, true);
    assert.equal(res.sha, 'base123');
    const post = calls.find((c) => c.method === 'POST')!;
    assert.deepEqual(post.body, { ref: 'refs/heads/agent/feat-1.2', sha: 'base123' });
  });

  it('createBranch is idempotent on 422', async () => {
    const { fetchFn } = mockGithub({
      'GET git/ref/heads/main': { object: { sha: 'base123' } },
      'POST git/refs': { __status: 422, message: 'Reference already exists' },
    });
    const res = (await exec(githubTools(ctx(fetchFn)), 'createBranch', {})) as {
      created: boolean;
    };
    assert.equal(res.created, false);
  });

  it('commitChanges runs blobs → tree → commit → ref in order', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-gh-'));
    execFileSync('git', ['init'], { cwd: dir });
    writeFileSync(path.join(dir, 'new.ts'), 'export const x = 1;\n');
    const order: string[] = [];
    const { fetchFn } = mockGithub({
      'GET git/ref/heads/agent/feat-1.2': { object: { sha: 'head1' } },
      'GET git/commits/head1': { tree: { sha: 'tree0' } },
      'POST git/blobs': { sha: 'blob1' },
      'POST git/trees': { sha: 'tree1' },
      'POST git/commits': { sha: 'commit1' },
      'PATCH git/refs/heads/agent/feat-1.2': { ref: 'refs/heads/agent/feat-1.2' },
    });
    const wrapped: typeof fetch = (async (i: unknown, init?: { method?: string }) => {
      order.push(`${init?.method ?? 'GET'} ${String(i).split('api.github.com/')[1]}`);
      return fetchFn(i as never, init as never);
    }) as never;

    const res = (await exec(githubTools(ctx(wrapped, dir)), 'commitChanges', {
      message: 'feat: x',
    })) as { committed: boolean; sha: string; files: string[] };

    assert.equal(res.committed, true);
    assert.equal(res.sha, 'commit1');
    assert.deepEqual(res.files, ['new.ts']);
    assert.deepEqual(
      order.map((o) => o.split(' ')[0] + ' ' + o.split('/').pop()!.split('?')[0]),
      ['GET feat-1.2', 'GET head1', 'POST blobs', 'POST trees', 'POST commits', 'PATCH feat-1.2'],
    );
  });

  it('commitChanges reports a clean tree without touching the API', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-gh-clean-'));
    execFileSync('git', ['init'], { cwd: dir });
    const { calls, fetchFn } = mockGithub({});
    const res = (await exec(githubTools(ctx(fetchFn, dir)), 'commitChanges', {
      message: 'x',
    })) as { committed: boolean };
    assert.equal(res.committed, false);
    assert.equal(calls.length, 0);
  });

  it('openPR falls back to the existing PR on 422', async () => {
    const { fetchFn } = mockGithub({
      'POST pulls': { __status: 422, message: 'A pull request already exists' },
      'GET head=o:agent/feat-1.2': [{ html_url: 'https://github.com/o/r/pull/7', number: 7 }],
    });
    const res = (await exec(githubTools(ctx(fetchFn)), 'openPR', {
      title: 't',
      body: 'b',
    })) as { pr_url: string; pr_number: number; created: boolean };
    assert.equal(res.pr_number, 7);
    assert.equal(res.created, false);
  });
});

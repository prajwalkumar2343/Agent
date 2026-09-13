import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';

const execAsync = promisify(exec);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vercel', '.next', 'coverage']);
const MAX_LIST = 500;
const MAX_READ_LINES = 2000;
const MAX_SHELL_OUTPUT = 8_000;

// Pipeline credentials the agent shell must never see — a prompt-injected
// repo file could otherwise exfiltrate them.
const ENV_DENYLIST = [
  'GH_AGENT_PAT',
  'ANTHROPIC_API_KEY',
  'RUN_CALLBACK_SECRET',
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
  'KV_REST_API_TOKEN',
  'POSTHOG_API_KEY',
  'SIM_API_KEY',
];

/**
 * Workspace tools for the coding agent, confined to `root` (the checked-out
 * product repo). Path confinement is the sandbox — every tool resolves the
 * requested path and rejects escapes, so a prompt-injected repo file cannot
 * read/write outside the checkout. Git/PR/HTTP effects stay in the workflow.
 */
export function workspaceTools(root: string) {
  const base = path.resolve(root);
  const inside = (p: string): string => {
    const resolved = path.resolve(base, p);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`path escapes workspace: ${p}`);
    }
    return resolved;
  };

  const shellEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v !== undefined && !ENV_DENYLIST.includes(k)),
  ) as Record<string, string>;

  return {
    readFile: tool({
      description:
        'Read a UTF-8 file from the product repo with line numbers. ' +
        'Use offset/limit for large files.',
      inputSchema: z.object({
        path: z.string().describe('repo-relative path'),
        offset: z.number().int().min(1).optional().describe('1-based start line'),
        limit: z.number().int().min(1).max(MAX_READ_LINES).optional(),
      }),
      execute: async ({ path: p, offset, limit }) => {
        const resolved = inside(p);
        if ((await stat(resolved)).isDirectory()) {
          return `error: ${p} is a directory — use listFiles`;
        }
        const lines = (await readFile(resolved, 'utf8')).split('\n');
        const start = (offset ?? 1) - 1;
        const slice = lines.slice(start, start + (limit ?? MAX_READ_LINES));
        return (
          slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n') +
          (start + slice.length < lines.length
            ? `\n… [${lines.length - start - slice.length} more lines]`
            : '')
        );
      },
    }),

    writeFile: tool({
      description: 'Write (create or overwrite) a UTF-8 file in the product repo.',
      inputSchema: z.object({
        path: z.string().describe('repo-relative path'),
        content: z.string(),
      }),
      execute: async ({ path: p, content }) => {
        const resolved = inside(p);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content, 'utf8');
        return `wrote ${path.relative(base, resolved)} (${Buffer.byteLength(content)} bytes)`;
      },
    }),

    listFiles: tool({
      description: 'List repo files (recursive, skips node_modules/.git/build dirs).',
      inputSchema: z.object({
        dir: z.string().optional().describe('subdir to list, default root'),
        depth: z.number().int().min(1).max(10).optional(),
      }),
      execute: async ({ dir, depth }) => {
        const out: string[] = [];
        const walk = async (d: string, dd: number): Promise<void> => {
          if (dd < 0) return;
          for (const e of await readdir(d, { withFileTypes: true })) {
            if (out.length >= MAX_LIST) return;
            if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
            const full = path.join(d, e.name);
            if (e.isDirectory()) await walk(full, dd - 1);
            else out.push(path.relative(base, full));
          }
        };
        await walk(inside(dir ?? '.'), depth ?? 4);
        return out;
      },
    }),

    runShell: tool({
      description:
        'Run a bash command in the product repo: the repo\'s checks (typecheck, ' +
        'tests, build), read-only git (status/diff/log — the workflow owns ' +
        'commit/push/PR), sed for edits. 60s timeout, output capped at 8KB.',
      inputSchema: z.object({
        command: z.string(),
        timeout_ms: z.number().int().min(1).max(600_000).optional(),
      }),
      execute: async ({ command, timeout_ms }) => {
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: base,
            timeout: timeout_ms ?? 60_000,
            maxBuffer: 4 * 1024 * 1024,
            env: shellEnv,
          });
          return (stdout + stderr).slice(0, MAX_SHELL_OUTPUT) || '(no output)';
        } catch (err) {
          const e = err as { message?: string; stdout?: string; stderr?: string };
          return `exit non-zero: ${e.message}\n${(e.stdout ?? '') + (e.stderr ?? '')}`.slice(
            0,
            MAX_SHELL_OUTPUT,
          );
        }
      },
    }),
  };
}

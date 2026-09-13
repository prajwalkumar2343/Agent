import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool } from 'ai';
import { z } from 'zod';
import { assessShellCommand, scrubEnv } from '../../../guard/src/index.ts';
import { GIT_SEALED_ENV } from '../sandbox/types.ts';

const execAsync = promisify(exec);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vercel', '.next', 'coverage']);
const MAX_LIST = 500;
const MAX_READ_LINES = 2000;
const MAX_SHELL_OUTPUT = 8_000;

/** Repo-internal paths the file tools never read or write — codex's
 * workspace-write treats .git as read-only; .env* holds secrets. */
const TOOL_PROTECTED =
  /(^|\/)\.git($|\/)|(^|\/)\.env($|\.)|(^|\/)\.ssh($|\/)|(^|\/)id_[a-z0-9]+$|\.(pem|p12|pfx|key)$/i;

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
  const relative = (p: string): string => path.relative(base, inside(p));

  // Shell env: pattern-scrubbed (no *KEY*/*SECRET*/*TOKEN*/... vars) and
  // git-sealed so a runaway command can't reach credentials.
  const shellEnv = {
    ...scrubEnv().env,
    ...GIT_SEALED_ENV,
  } as Record<string, string>;

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
        const rel = relative(p);
        if (TOOL_PROTECTED.test(rel)) return `denied: ${p} is a protected path`;
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
        const rel = relative(p);
        if (TOOL_PROTECTED.test(rel)) return `denied: ${p} is a protected path`;
        const resolved = inside(p);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content, 'utf8');
        return `wrote ${rel} (${Buffer.byteLength(content)} bytes)`;
      },
    }),

    listFiles: tool({
      description: 'List repo files (recursive, skips node_modules/.git/build dirs).',
      inputSchema: z.object({
        dir: z.string().optional().describe('subdir to list, default root'),
        depth: z.number().int().min(1).max(10).optional(),
      }),
      execute: async ({ dir, depth }) => {
        const rel = relative(dir ?? '.');
        if (TOOL_PROTECTED.test(rel)) return `denied: ${dir} is a protected path`;
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
        'tests, build), read-only git (status/diff/log), sed for edits. Every ' +
        'command is vetted by shell policy before it runs — mutations, network ' +
        'egress, env access, and workspace escapes are denied. ' +
        '60s timeout, output capped at 8KB.',
      inputSchema: z.object({
        command: z.string(),
        timeout_ms: z.number().int().min(1).max(600_000).optional(),
      }),
      execute: async ({ command, timeout_ms }) => {
        const verdict = assessShellCommand(command, { root: base });
        if (verdict.decision === 'deny') {
          return `denied by shell policy: ${verdict.reason}`;
        }
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

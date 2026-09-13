import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { scanChangedPaths } from '../../../guard/src/index.ts';
import type { SandboxProvider } from '../sandbox/types.ts';

const execFileAsync = promisify(execFile);

export interface VmCoderResult {
  /** pi's report — returned to the orchestrator as the tool result. */
  report: string;
  /** Files the applied patch touched. */
  filesChanged: string[];
  /** Whether the sandbox produced a non-empty diff. */
  applied: boolean;
  patchBytes: number;
  exitCode: number;
  /** pi's raw JSONL events — caller artifact, not sent to the model. */
  eventsJsonl?: string;
}

export interface VmCoderContext {
  sandbox: SandboxProvider;
  /** Local checkout that mirrors the sandbox tree — the patch lands here. */
  repoDir: string;
  /** Default wall-clock budget per pi invocation, ms. */
  timeoutMs?: number;
  /** Per-run cap on VM invocations — the cost ceiling (default unlimited). */
  maxCalls?: number;
  onResult?: (r: VmCoderResult) => void;
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repoDir });
  return stdout;
}

/**
 * Mirror the sandbox state into the local checkout: reset to base, then
 * apply the cumulative patch. Reset-then-apply keeps repeat calls idempotent
 * — the local tree always ends up exactly matching the VM's.
 */
async function applyPatch(repoDir: string, patch: string): Promise<string[]> {
  await git(repoDir, ['checkout', '--', '.']);
  await git(repoDir, ['clean', '-fd']);
  if (patch.trim()) {
    // Unique per call — parallel eval trials share the pid's tmpdir.
    const f = path.join(
      tmpdir(),
      `vm-patch-${process.pid}-${crypto.randomUUID()}.diff`,
    );
    await writeFile(f, patch);
    await git(repoDir, ['apply', '--whitespace=nowarn', f]);
  }
  const status = await git(repoDir, ['status', '--porcelain']);
  return status
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!);
}

/**
 * The tool exposed to the orchestrator. Calling it suspends the
 * orchestrator's loop while pi runs in the sandbox; the diff is applied to
 * the local checkout deterministically and pi's report returns as the tool
 * result. Repeat calls continue on the same sandbox tree — the orchestrator
 * re-delegates when verification fails.
 */
export function vmCoderDelegateTool(ctx: VmCoderContext): Tool {
  let calls = 0;
  return tool({
    description:
      'Run the coding task in an isolated VM (pi coding agent). pi owns the ' +
      'change end to end there: it edits the product repo, commits, pushes ' +
      'the fixed feature branch, and opens the PR — the PR URL comes back in ' +
      'its report. The resulting diff is also applied to your local checkout ' +
      'automatically for verification. Input: a complete task spec — the VM ' +
      'agent cannot see your context. Call again with failure output to have ' +
      'it fix verification failures (it pushes follow-up commits).',
    inputSchema: z.object({
      task: z.string().describe('Complete coding task: what to build, acceptance criteria, constraints'),
    }),
    execute: async ({ task }) => {
      if (ctx.maxCalls !== undefined && ++calls > ctx.maxCalls) {
        return {
          applied: false,
          files_changed: [],
          report: '',
          error: `VM invocation budget exhausted (${ctx.maxCalls}/run) — report the blocker.`,
        };
      }
      const res = await ctx.sandbox.runTask({ task, timeoutMs: ctx.timeoutMs });
      let filesChanged: string[] = [];
      let applyError: string | undefined;
      try {
        filesChanged = await applyPatch(ctx.repoDir, res.patch);
      } catch (err) {
        applyError = err instanceof Error ? err.message : String(err);
      }
      // pi commits+pushes itself now — the commit-time path scan is gone, so
      // surface protected-path findings here: the merge gate will reject
      // them; the orchestrator can have pi back them out.
      const blocked = scanChangedPaths(filesChanged).filter((f) => f.severity === 'block');
      const result: VmCoderResult = {
        report: res.report,
        filesChanged,
        applied: res.patch.trim().length > 0 && !applyError,
        patchBytes: Buffer.byteLength(res.patch),
        exitCode: res.exitCode,
        eventsJsonl: res.eventsJsonl,
      };
      ctx.onResult?.(result);
      return {
        applied: result.applied,
        files_changed: filesChanged,
        report: res.report,
        ...(res.exitCode !== 0 ? { warning: `pi exited ${res.exitCode}` } : {}),
        ...(applyError ? { apply_error: applyError } : {}),
        ...(blocked.length
          ? {
              blocked_paths: blocked.map((b) => `${b.path} (${b.rule})`),
              note: 'diff touches protected paths — the merge gate rejects them; re-delegate to have pi move the change inside the feature’s own paths',
            }
          : {}),
      };
    },
  });
}

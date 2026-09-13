import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  SandboxProvider,
  SandboxRunResult,
  SandboxTask,
} from '../../src/sandbox/types.ts';
import type { VmScriptStep } from './types.ts';

/**
 * Eval sandbox — plays the VM coder without E2B or pi. Holds a private git
 * copy of the fixture repo; on the Nth `delegate_to_vm_coder` call it applies
 * `reference.vm_script[N]` (writes/deletes) to that copy and returns the
 * cumulative `git diff` vs the shipped base — exercising the real
 * patch-apply path in tools/vmCoder.ts.
 *
 * No vm_script → the "VM" produces an empty diff (right default for
 * control/abstention tasks).
 */
export class EvalSandbox implements SandboxProvider {
  readonly name = 'eval';
  private vmDir: string | null = null;
  private baseSha = '';
  private calls = 0;
  private fixtureDir: string;
  private script: VmScriptStep[];

  constructor(fixtureDir: string, script: VmScriptStep[]) {
    this.fixtureDir = fixtureDir;
    this.script = script;
  }

  private async ensure(): Promise<string> {
    if (!this.vmDir) {
      this.vmDir = mkdtempSync(path.join(tmpdir(), 'eval-vm-'));
      await cp(this.fixtureDir, this.vmDir, { recursive: true });
      this.baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: this.vmDir })
        .toString()
        .trim();
    }
    return this.vmDir;
  }

  async runTask(_req: SandboxTask): Promise<SandboxRunResult> {
    const dir = await this.ensure();
    // Calls beyond the script length are no-ops — never replay the last step.
    const step = this.calls < this.script.length ? this.script[this.calls] : undefined;
    this.calls++;
    let report = step?.report ?? 'eval-vm: done';

    if (step) {
      for (const [rel, content] of Object.entries(step.writes ?? {})) {
        const p = path.join(dir, rel);
        await mkdir(path.dirname(p), { recursive: true });
        await writeFile(p, content, 'utf8');
      }
      for (const rel of step.deletes ?? []) {
        await rm(path.join(dir, rel), { force: true });
      }
    }

    execFileSync('git', ['add', '-A'], { cwd: dir });
    try {
      execFileSync(
        'git',
        ['-c', 'user.email=eval@vm', '-c', 'user.name=eval-vm', 'commit', '-qm', 'wip', '--no-verify'],
        { cwd: dir },
      );
    } catch {
      /* clean tree */
    }
    const patch = execFileSync('git', ['diff', '--binary', this.baseSha, 'HEAD'], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
    }).toString();

    if (step?.exit_code && step.exit_code !== 0) {
      report = step.report ?? `eval-vm: simulated failure`;
    }
    return { patch, report, exitCode: step?.exit_code ?? 0 };
  }

  async kill(): Promise<void> {
    if (this.vmDir) rmSync(this.vmDir, { recursive: true, force: true });
    this.vmDir = null;
  }
}

export function evalSandbox(fixtureDir: string, script: VmScriptStep[] = []): EvalSandbox {
  return new EvalSandbox(fixtureDir, script);
}

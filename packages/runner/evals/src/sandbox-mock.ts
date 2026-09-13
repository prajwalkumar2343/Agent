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
import type { ToolCallRecord } from '../../src/harness.ts';
import type { MockGithub } from './github-mock.ts';
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
 *
 * pi also owns the remote writes in production — when `gh` is passed, the
 * fake VM plays that side too: after a step lands a diff it drives the
 * mocked REST backend through the same refs→commit→pulls sequence the real
 * sandbox's git+token would, so `gh.state()` and the world-state graders
 * still see a faithful backend (incl. the failure presets: 422 re-runs,
 * flaky 500s, openPR always failing).
 */
export class EvalSandbox implements SandboxProvider {
  readonly name = 'eval';
  private vmDir: string | null = null;
  private baseSha = '';
  private calls = 0;
  private fixtureDir: string;
  private script: VmScriptStep[];
  private gh?: MockGithub;
  private branch: string;
  /**
   * Remote ops the fake VM performed, recorded with the old github-agent
   * tool names (createBranch/commitChanges/openPR) so `gh_*` graders keep
   * the same meaning: "the pipeline created the branch / committed / PRed".
   */
  readonly ghCalls: ToolCallRecord[] = [];

  constructor(fixtureDir: string, script: VmScriptStep[], opts?: { gh?: MockGithub; branch?: string }) {
    this.fixtureDir = fixtureDir;
    this.script = script;
    this.gh = opts?.gh;
    this.branch = opts?.branch ?? 'agent/eval';
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

    // The fake VM's remote side: a non-empty cumulative diff means pi pushed
    // its branch — simulate branch→commit→PR against the gh mock and surface
    // the outcome in the report exactly as pi's report would carry it.
    if (this.gh && patch.trim()) {
      report += `\n${await this.shipRemote()}`;
    }
    return { patch, report, exitCode: step?.exit_code ?? 0 };
  }

  /**
   * Drive the mocked GitHub backend through the same flow pi owns in the
   * real sandbox (base-ref lookup → create ref → commit → open PR, 422 =
   * re-run → continue/reuse, one retry on 5xx). Each step is recorded in
   * `ghCalls` under the removed github-agent tool names so `gh_called` /
   * `gh_order` / `gh_call_count` / `gh_state` graders still see the remote
   * flow — including the failure presets.
   */
  private async shipRemote(): Promise<string> {
    const gh = this.gh!;
    const rec = (toolName: string, output: unknown, isError = false) =>
      this.ghCalls.push({ step: 0, toolName, input: {}, output, isError });
    const req = (method: string, p: string, body?: unknown) =>
      gh.fetchFn(`https://api.github.com/repos/acme/app/${p}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    try {
      // createBranch: resolve the base ref, then POST the ref. The
      // malformed-ref preset fails the lookup; 422 = branch already exists.
      let branchReady = false;
      for (let attempt = 0; attempt < 2 && !branchReady; attempt++) {
        let baseSha = '';
        try {
          const d = (await (await req('GET', 'git/ref/heads/main')).json()) as {
            object?: { sha?: string };
          };
          baseSha = d.object?.sha ?? '';
          if (!baseSha) throw new Error('malformed ref response');
        } catch (err) {
          rec('createBranch', `base ref lookup failed: ${err instanceof Error ? err.message : err}`, true);
          continue;
        }
        const res = await req('POST', 'git/refs', {
          ref: `refs/heads/${this.branch}`,
          sha: baseSha,
        });
        if (res.ok || res.status === 422) {
          rec('createBranch', { status: res.status, note: res.status === 422 ? 'branch exists' : 'created' });
          branchReady = true;
        } else {
          rec('createBranch', { status: res.status }, true);
          if (res.status < 500) break;
        }
      }
      if (!branchReady) return 'push failed: could not create branch';

      const commit = await req('POST', 'git/commits', { message: 'feat: eval change' });
      rec('commitChanges', { status: commit.status }, !commit.ok);
      if (!commit.ok) return `push failed: commit (${commit.status})`;

      for (let attempt = 0; attempt < 2; attempt++) {
        const pr = await req('POST', 'pulls', {
          title: 'feat: eval change',
          body: 'eval',
          head: this.branch,
          base: 'main',
        });
        if (pr.ok) {
          const d = (await pr.json()) as { html_url?: string; number?: number };
          rec('openPR', { pr_url: d.html_url, pr_number: d.number, created: true });
          return `PR: ${d.html_url}`;
        }
        if (pr.status === 422) {
          const list = await req('GET', `pulls?state=open&head=acme:${this.branch}`);
          const arr = (await list.json()) as { html_url?: string; number?: number }[];
          if (arr[0]?.html_url) {
            rec('openPR', { pr_url: arr[0].html_url, pr_number: arr[0].number, created: false });
            return `PR: ${arr[0].html_url} (existing)`;
          }
          rec('openPR', { status: 422 }, true);
          return 'PR creation failed (422, none found)';
        }
        rec('openPR', { status: pr.status }, true);
        if (pr.status < 500) return `PR creation failed (${pr.status})`;
      }
      return 'PR creation failed (500)';
    } catch (err) {
      return `remote write failed: ${err instanceof Error ? err.message : err}`;
    }
  }

  async kill(): Promise<void> {
    if (this.vmDir) rmSync(this.vmDir, { recursive: true, force: true });
    this.vmDir = null;
  }
}

export function evalSandbox(
  fixtureDir: string,
  script: VmScriptStep[] = [],
  opts?: { gh?: MockGithub; branch?: string },
): EvalSandbox {
  return new EvalSandbox(fixtureDir, script, opts);
}

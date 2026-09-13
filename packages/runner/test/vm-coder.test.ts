import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Tool } from 'ai';
import { vmCoderDelegateTool, type VmCoderResult } from '../src/tools/vmCoder.ts';
import type { SandboxProvider, SandboxRunResult, SandboxTask } from '../src/sandbox/types.ts';

const OPTS = { toolCallId: 't1', messages: [] };

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-vm-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(path.join(dir, 'base.txt'), 'old\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

const ADD_FEAT = `diff --git a/feat.ts b/feat.ts
new file mode 100644
index 0000000..3be9c81
--- /dev/null
+++ b/feat.ts
@@ -0,0 +1 @@
+export const f = 1;
`;

const MODIFY_BASE = `diff --git a/base.txt b/base.txt
index 3367afd..4724c24 100644
--- a/base.txt
+++ b/base.txt
@@ -1 +1 @@
-old
+new
`;

class FakeSandbox implements SandboxProvider {
  readonly name = 'fake';
  patches: string[] = [];
  tasks: SandboxTask[] = [];
  async runTask(req: SandboxTask): Promise<SandboxRunResult> {
    this.tasks.push(req);
    return { patch: this.patches.shift() ?? '', report: 'vm: done', exitCode: 0 };
  }
  async kill(): Promise<void> {}
}

async function exec(t: Tool, input: unknown) {
  assert.ok(t.execute);
  return t.execute(input as never, OPTS);
}

describe('delegate_to_vm_coder', () => {
  it('applies the sandbox patch to the local checkout', async () => {
    const dir = initRepo();
    const sandbox = new FakeSandbox();
    sandbox.patches.push(ADD_FEAT);
    let got: VmCoderResult | undefined;
    const t = vmCoderDelegateTool({
      sandbox,
      repoDir: dir,
      onResult: (r) => (got = r),
    });

    const out = (await exec(t, { task: 'add feat' })) as Record<string, unknown>;
    assert.equal(out.applied, true);
    assert.deepEqual(out.files_changed, ['feat.ts']);
    assert.equal(readFileSync(path.join(dir, 'feat.ts'), 'utf8'), 'export const f = 1;\n');
    assert.equal(got!.report, 'vm: done');
  });

  it('reset+apply keeps repeat calls consistent with the cumulative diff', async () => {
    const dir = initRepo();
    const sandbox = new FakeSandbox();
    sandbox.patches.push(ADD_FEAT, MODIFY_BASE);
    const t = vmCoderDelegateTool({ sandbox, repoDir: dir });

    await exec(t, { task: 'first' });
    assert.ok(existsSync(path.join(dir, 'feat.ts')));

    // Second call returns a patch that no longer includes feat.ts —
    // reset must remove it before applying the new cumulative diff.
    const out = (await exec(t, { task: 'second' })) as Record<string, unknown>;
    assert.equal(out.applied, true);
    assert.equal(readFileSync(path.join(dir, 'base.txt'), 'utf8'), 'new\n');
    assert.ok(!existsSync(path.join(dir, 'feat.ts')), 'stale file from first patch removed');
  });

  it('reports applied=false when the sandbox returns an empty diff', async () => {
    const dir = initRepo();
    const sandbox = new FakeSandbox();
    sandbox.patches.push('');
    const t = vmCoderDelegateTool({ sandbox, repoDir: dir });
    const out = (await exec(t, { task: 'noop' })) as Record<string, unknown>;
    assert.equal(out.applied, false);
    assert.deepEqual(out.files_changed, []);
    // Tree is untouched.
    assert.equal(readFileSync(path.join(dir, 'base.txt'), 'utf8'), 'old\n');
  });
});

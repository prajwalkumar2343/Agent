import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { createOrchestrator, buildOrchestratorPrompt } from '../src/agents/orchestrator.ts';
import type { SandboxProvider, SandboxRunResult, SandboxTask } from '../src/sandbox/types.ts';

const USAGE: LanguageModelV3GenerateResult['usage'] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function call(id: string, name: string, input: unknown): LanguageModelV3GenerateResult {
  return {
    content: [
      { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: USAGE,
    warnings: [],
  };
}

function text(t: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text: t }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: USAGE,
    warnings: [],
  };
}

function seq(...r: LanguageModelV3GenerateResult[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => r[Math.min(i++, r.length - 1)]!,
  });
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-orch-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(path.join(dir, 'base.txt'), 'old\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

const PATCH = `diff --git a/feat.ts b/feat.ts
new file mode 100644
index 0000000..3be9c81
--- /dev/null
+++ b/feat.ts
@@ -0,0 +1 @@
+export const f = 1;
`;

class FakeSandbox implements SandboxProvider {
  readonly name = 'fake';
  tasks: SandboxTask[] = [];
  private patch: string;
  private report: string;
  constructor(patch: string, report = 'vm: implemented\nPR: https://github.com/o/r/pull/9') {
    this.patch = patch;
    this.report = report;
  }
  async runTask(req: SandboxTask): Promise<SandboxRunResult> {
    this.tasks.push(req);
    return { patch: this.patch, report: this.report, exitCode: 0 };
  }
  async kill(): Promise<void> {}
}

describe('orchestrator → pi pipeline', () => {
  it('delegates the whole change to the VM — pi commits/pushes/PRs itself', async () => {
    const dir = initRepo();

    // Orchestrator: delegate to pi (which codes + ships), then report.
    const model = seq(
      call('p1', 'delegate_to_vm_coder', { task: 'add feat.ts' }),
      text('shipped: https://github.com/o/r/pull/9'),
    );

    const sandbox = new FakeSandbox(PATCH);
    const spec = { title: 't', slug: 'f', summary: 's', acceptance: ['a'] };
    const harness = createOrchestrator({
      root: dir,
      branch: 'agent/f-1.0',
      sandbox,
      spec,
      flagKey: 'feat_f',
      model,
    });

    const result = await harness.run(buildOrchestratorPrompt({ spec, flagKey: 'feat_f' }));

    // VM patch was applied locally for verification.
    assert.ok(existsSync(path.join(dir, 'feat.ts')));
    assert.equal(readFileSync(path.join(dir, 'feat.ts'), 'utf8'), 'export const f = 1;\n');
    assert.equal(sandbox.tasks.length, 1);
    assert.match(sandbox.tasks[0]!.task, /add feat\.ts/);

    // pi's report (with the PR URL it created) comes back as the tool result.
    const delegate = result.toolCalls.find((c) => c.toolName === 'delegate_to_vm_coder');
    assert.match(String((delegate?.output as { report?: string })?.report ?? ''), /pull\/9/);
    assert.match(result.text, /pull\/9/);
    assert.deepEqual(
      result.toolCalls.map((r) => r.toolName),
      ['delegate_to_vm_coder'],
    );
  });

  it('the removed delegate_to_github tool errors if the model calls it', async () => {
    const dir = initRepo();
    const model = seq(call('x1', 'delegate_to_github', { summary: 'x' }), text('done'));
    const harness = createOrchestrator({
      root: dir,
      branch: 'agent/f-1.0',
      sandbox: new FakeSandbox(''),
      spec: { title: 't', slug: 'f', summary: 's', acceptance: [] },
      flagKey: 'feat_f',
      model,
    });
    const r = await harness.run('go');
    assert.equal(r.toolCalls[0]?.toolName, 'delegate_to_github');
    assert.equal(r.toolCalls[0]?.isError, true);
  });
});

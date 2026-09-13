import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { createOrchestrator, buildOrchestratorPrompt } from '../src/agents/orchestrator.ts';
import type { GithubToolsContext } from '../src/tools/github.ts';
import type { GithubHandoffResult } from '../src/agents/github.ts';
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
  constructor(patch: string, report = 'vm: implemented') {
    this.patch = patch;
    this.report = report;
  }
  async runTask(req: SandboxTask): Promise<SandboxRunResult> {
    this.tasks.push(req);
    return { patch: this.patch, report: this.report, exitCode: 0 };
  }
  async kill(): Promise<void> {}
}

describe('orchestrator handoff', () => {
  it('delegates coding to the VM, applies the patch, then delegates to github', async () => {
    const dir = initRepo();

    // Secondary agent: openPR (mocked fetch), then report text.
    const ghModel = seq(
      call('g1', 'openPR', { title: 'feat: x', body: 'b' }),
      text('PR opened: https://github.com/o/r/pull/9'),
    );
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ html_url: 'https://github.com/o/r/pull/9', number: 9 }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const github: GithubToolsContext = {
      repo: 'o/r',
      token: 'tok',
      branch: 'agent/f-1.0',
      base: 'main',
      repoDir: dir,
      fetchFn,
    };

    // Orchestrator: delegate to VM coder, delegate to github, then report.
    const model = seq(
      call('p1', 'delegate_to_vm_coder', { task: 'add feat.ts' }),
      call('p2', 'delegate_to_github', { summary: 'added feat.ts' }),
      text('shipped: https://github.com/o/r/pull/9'),
    );

    const sandbox = new FakeSandbox(PATCH);
    let handoff: GithubHandoffResult | undefined;
    const spec = { title: 't', slug: 'f', summary: 's', acceptance: ['a'] };
    const harness = createOrchestrator({
      root: dir,
      github,
      sandbox,
      spec,
      flagKey: 'feat_f',
      model,
      githubModel: ghModel,
      onHandoff: (r) => {
        handoff = r;
      },
    });

    const result = await harness.run(buildOrchestratorPrompt({ spec, flagKey: 'feat_f' }));

    // VM patch was applied locally — the file the github agent commits exists.
    assert.ok(existsSync(path.join(dir, 'feat.ts')));
    assert.equal(readFileSync(path.join(dir, 'feat.ts'), 'utf8'), 'export const f = 1;\n');
    assert.equal(sandbox.tasks.length, 1);
    assert.match(sandbox.tasks[0]!.task, /add feat\.ts/);

    assert.ok(handoff, 'github agent result reached orchestrator');
    assert.equal(handoff!.pr_number, 9);
    assert.match(result.text, /pull\/9/);
    assert.deepEqual(
      result.toolCalls.map((r) => r.toolName),
      ['delegate_to_vm_coder', 'delegate_to_github'],
    );
  });
});

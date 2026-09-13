import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { createCodingAgent, buildCodingPrompt } from '../src/agents/coding.ts';
import type { GithubToolsContext } from '../src/tools/github.ts';
import type { GithubHandoffResult } from '../src/agents/github.ts';

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

describe('two-agent handoff', () => {
  it('primary delegates to github agent, which reports back', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-deleg-'));
    writeFileSync(path.join(dir, 'feat.ts'), 'export const f = 1;\n');

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

    // Primary agent: write file, delegate, then report with the PR it got back.
    const model = seq(
      call('p1', 'delegate_to_github', { summary: 'added feat.ts' }),
      text('shipped: https://github.com/o/r/pull/9'),
    );

    let handoff: GithubHandoffResult | undefined;
    const spec = { title: 't', slug: 'f', summary: 's', acceptance: ['a'] };
    const harness = createCodingAgent({
      root: dir,
      github,
      spec,
      flagKey: 'feat_f',
      model,
      githubModel: ghModel,
      onHandoff: (r) => {
        handoff = r;
      },
    });

    const result = await harness.run(buildCodingPrompt({ spec, flagKey: 'feat_f' }));

    assert.ok(handoff, 'github agent result reached primary');
    assert.equal(handoff!.pr_number, 9);
    assert.equal(handoff!.branch, 'agent/f-1.0');
    assert.match(handoff!.report, /pull\/9/);
    assert.match(result.text, /pull\/9/); // primary saw the report and used it
    assert.deepEqual(
      result.toolCalls.map((r) => r.toolName),
      ['delegate_to_github'],
    );
  });
});

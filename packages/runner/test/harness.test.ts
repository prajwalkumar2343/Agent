import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { z } from 'zod';
import { createHarness } from '../src/harness.ts';
import { workspaceTools } from '../src/tools/workspace.ts';

const USAGE: LanguageModelV3GenerateResult['usage'] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function toolCallResult(id: string, name: string, input: unknown): LanguageModelV3GenerateResult {
  return {
    content: [
      { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: USAGE,
    warnings: [],
  };
}

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: USAGE,
    warnings: [],
  };
}

function modelSeq(...results: LanguageModelV3GenerateResult[]): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => results[Math.min(i++, results.length - 1)]!,
  });
}

describe('harness', () => {
  it('runs the tool loop until the model stops calling tools', async () => {
    let pinged = 0;
    const model = modelSeq(toolCallResult('c1', 'ping', { n: 1 }), textResult('done'));
    const harness = createHarness({
      model,
      tools: {
        ping: tool({
          inputSchema: z.object({ n: z.number() }),
          execute: ({ n }) => {
            pinged++;
            return { pong: n };
          },
        }),
      },
      logger: null,
    });

    const result = await harness.run('go');
    assert.equal(pinged, 1);
    assert.equal(result.text, 'done');
    assert.equal(result.steps.length, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.toolName, 'ping');
    assert.deepEqual(result.toolCalls[0]!.output, { pong: 1 });
    assert.equal(result.truncated, false);
  });

  it('marks truncated when maxSteps is hit mid-loop', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => toolCallResult(`c${Math.random()}`, 'ping', {}),
    });
    const harness = createHarness({
      model,
      tools: {
        ping: tool({ inputSchema: z.object({}).loose(), execute: () => 'pong' }),
      },
      maxSteps: 3,
      logger: null,
    });
    const result = await harness.run('go');
    assert.equal(result.steps.length, 3);
    assert.equal(result.truncated, true);
  });

  it('drives real workspace tools end-to-end', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-e2e-'));
    const model = modelSeq(
      toolCallResult('c1', 'writeFile', { path: 'hello.txt', content: 'world' }),
      toolCallResult('c2', 'readFile', { path: 'hello.txt' }),
      textResult('wrote hello.txt'),
    );
    const harness = createHarness({
      model,
      tools: workspaceTools(dir),
      logger: null,
    });
    const result = await harness.run('create hello.txt containing "world"');
    assert.equal(readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'world');
    assert.deepEqual(
      result.toolCalls.map((r) => r.toolName),
      ['writeFile', 'readFile'],
    );
    assert.match(result.toolCalls[1]!.output as string, /1\tworld/);
  });
});

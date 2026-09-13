import type { LanguageModelV3GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import type { ScriptStep } from './types.ts';

/**
 * Scenario-scripted model for `--verify-refs` and deterministic CI runs:
 * replays a reference trajectory through the REAL harness + tools, which is
 * how we prove every dataset task is solvable and every deterministic grader
 * fires correctly. Also used to synthesize known-failure traces (Tool-Skip,
 * Result-Ignore, …) for grader unit tests and judge calibration.
 */

const USAGE: LanguageModelV3GenerateResult['usage'] = {
  inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: 0 },
  outputTokens: { total: 40, text: 40, reasoning: 0 },
};

let seq = 0;

function toResult(step: ScriptStep): LanguageModelV3GenerateResult {
  if (step.text !== undefined) {
    return {
      content: [{ type: 'text', text: step.text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: USAGE,
      warnings: [],
    };
  }
  const calls = step.calls ?? (step.tool ? [{ tool: step.tool, input: step.input }] : []);
  return {
    content: calls.map((c, i) => ({
      type: 'tool-call' as const,
      toolCallId: `sc${seq++}-${i}`,
      toolName: c.tool,
      input: JSON.stringify(c.input ?? {}),
    })),
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: USAGE,
    warnings: [],
  };
}

/**
 * Replay `script` in order; once exhausted, emits a stop text so a run always
 * terminates. `modelId` is set so traces carry a recognizable id.
 */
export function scriptedModel(script: ScriptStep[], modelId = 'eval-scripted'): MockLanguageModelV3 {
  let i = 0;
  return new MockLanguageModelV3({
    provider: 'eval',
    modelId,
    doGenerate: async () =>
      i < script.length
        ? toResult(script[i++]!)
        : toResult({ text: '(script exhausted — no further action)' }),
  });
}

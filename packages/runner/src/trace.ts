import { createHash } from 'node:crypto';
import type { LanguageModelUsage, StepResult, Tool, ToolSet } from 'ai';
import type { HarnessResult, ToolCallRecord } from './harness.ts';

/**
 * Trace span contract (OTel GenAI semantic conventions, adapted).
 *
 * The harness has no telemetry backend — this recorder turns a run's
 * HarnessResult + step/tool timing into the span shape the eval harness and
 * the online eval loop consume:
 *
 *   AGENT root  — session/model/version identity + totals
 *   LLM span    — one per model round-trip (one per AI SDK step)
 *   TOOL span   — one per executed tool call, with latency + error class
 *
 * Tool inputs are hashed, never stored raw: traces can flow to scoring/
 * review pipelines without leaking repo contents or PII. Full tool I/O stays
 * in HarnessResult.toolCalls for the eval runner (which is local-only).
 */

export interface TraceMeta {
  /** Which agent in the pipeline produced this trace ('coding' | 'github'). */
  agent: string;
  session_id: string;
  model_id: string;
  /** LLM provider (anthropic|openrouter|opencode) — defaults to 'anthropic'. */
  provider?: string;
  agent_version?: string;
  user_id?: string;
  tool_registry_hash?: string;
}

export interface LlmSpan {
  step: number;
  'gen_ai.system': string;
  'request.model': string;
  'usage.input_tokens': number;
  'usage.output_tokens': number;
  'usage.cache_read_tokens': number;
  'usage.cache_creation_tokens': number;
  finish_reason: string;
  /** Wall time attributed to this step (prev step end → this step end). */
  latency_ms: number;
  retry_count: number;
  tool_calls: string[];
}

export interface ToolSpan {
  step: number;
  agent: string;
  tool_call_id: string;
  tool_name: string;
  /** sha256 of the JSON input — never the raw args. */
  tool_input_hash: string;
  tool_latency_ms: number;
  tool_success: boolean;
  tool_error_class?: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface AgentTrace {
  meta: TraceMeta & {
    started_at: number;
    ended_at: number;
    total_ms: number;
    /** Non-streaming proxy for TTFT: wall time of the first model call. */
    time_to_first_step_ms: number;
  };
  llm: LlmSpan[];
  tools: ToolSpan[];
  /** Full inputs/outputs — local eval detail; strip before shipping traces. */
  toolCalls: ToolCallRecord[];
  text: string;
  finish_reason: string;
  truncated: boolean;
  usage: UsageTotals;
}

export function hashInput(input: unknown): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function usageTotals(u: LanguageModelUsage | undefined): UsageTotals {
  return {
    input_tokens: u?.inputTokens ?? 0,
    output_tokens: u?.outputTokens ?? 0,
    cache_read_tokens: u?.inputTokenDetails?.cacheReadTokens ?? 0,
    cache_creation_tokens: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

export interface TraceRecorder {
  /** Wrap a toolset so every execution is timed + classified. */
  wrapTools(tools: ToolSet): ToolSet;
  /** Feed each finished step (call from HarnessOptions.onStep). */
  onStep(step: StepResult<ToolSet>): void;
  /** Merge step/tool spans with the final result into a trace. */
  finish(result: HarnessResult): AgentTrace;
}

export function createTraceRecorder(meta: TraceMeta): TraceRecorder {
  const started = Date.now();
  const llm: LlmSpan[] = [];
  const tools: ToolSpan[] = [];
  /** toolCallId → span index, for merging step numbers at finish. */
  const byCallId = new Map<string, number>();
  let lastStepEnd = started;
  let firstStepMs = 0;

  return {
    wrapTools(toolset: ToolSet): ToolSet {
      const wrapped: ToolSet = {};
      for (const [name, t] of Object.entries(toolset)) {
        const orig = (t as Tool).execute;
        if (!orig) {
          wrapped[name] = t;
          continue;
        }
        wrapped[name] = {
          ...t,
          execute: async (input: unknown, options: { toolCallId: string }) => {
            const t0 = Date.now();
            const span: ToolSpan = {
              step: -1, // merged at finish()
              agent: meta.agent,
              tool_call_id: options.toolCallId,
              tool_name: name,
              tool_input_hash: hashInput(input),
              tool_latency_ms: 0,
              tool_success: false,
            };
            try {
              const out = await orig(input as never, options as never);
              span.tool_success = true;
              return out;
            } catch (err) {
              span.tool_error_class =
                err instanceof Error ? err.name : typeof err;
              throw err;
            } finally {
              span.tool_latency_ms = Date.now() - t0;
              byCallId.set(span.tool_call_id, tools.length);
              tools.push(span);
            }
          },
        } as Tool;
      }
      return wrapped;
    },

    onStep(step: StepResult<ToolSet>): void {
      const now = Date.now();
      const latency = now - lastStepEnd;
      lastStepEnd = now;
      if (step.stepNumber === 0) firstStepMs = latency;
      const u = step.usage;
      llm.push({
        step: step.stepNumber,
        'gen_ai.system': meta.provider ?? 'anthropic',
        'request.model': meta.model_id,
        'usage.input_tokens': u?.inputTokens ?? 0,
        'usage.output_tokens': u?.outputTokens ?? 0,
        'usage.cache_read_tokens': u?.inputTokenDetails?.cacheReadTokens ?? 0,
        'usage.cache_creation_tokens': u?.inputTokenDetails?.cacheWriteTokens ?? 0,
        finish_reason: step.finishReason,
        latency_ms: latency,
        retry_count: 0,
        tool_calls: step.toolCalls.map((tc) => tc.toolName),
      });
    },

    finish(result: HarnessResult): AgentTrace {
      // Merge step numbers + classify errors the wrapper couldn't see
      // (tool-error parts surface on the record, not as thrown exceptions).
      for (const rec of result.toolCalls) {
        const idx = rec.toolCallId ? byCallId.get(rec.toolCallId) : undefined;
        const span = idx != null ? tools[idx] : undefined;
        if (!span) continue;
        span.step = rec.step;
        if (rec.isError) {
          span.tool_success = false;
          span.tool_error_class ??= 'ToolError';
        }
      }
      const ended = Date.now();
      return {
        meta: {
          ...meta,
          started_at: started,
          ended_at: ended,
          total_ms: ended - started,
          time_to_first_step_ms: firstStepMs,
        },
        llm,
        tools,
        toolCalls: result.toolCalls,
        text: result.text,
        finish_reason: result.finishReason,
        truncated: result.truncated,
        usage: usageTotals(result.totalUsage),
      };
    },
  };
}

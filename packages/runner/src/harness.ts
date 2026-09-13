import {
  generateText,
  stepCountIs,
  type CallSettings,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepFunction,
  type StepResult,
  type StopCondition,
  type ToolSet,
} from 'ai';

export interface ToolCallRecord {
  step: number;
  toolName: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
}

export interface HarnessResult {
  /** Final assistant text (last step). */
  text: string;
  steps: Array<StepResult<ToolSet>>;
  /** Flattened log of every tool call across all steps, in order. */
  toolCalls: ToolCallRecord[];
  totalUsage: LanguageModelUsage;
  finishReason: string;
  /** Messages generated during the run (assistant + tool), appendable to continue the session. */
  responseMessages: ModelMessage[];
  /** True when the run stopped because maxSteps was hit rather than the model finishing. */
  truncated: boolean;
}

export interface HarnessOptions {
  model: LanguageModel;
  system?: string;
  /** Full toolset available to the agent. Compose workspace tools + extras before passing in. */
  tools: ToolSet;
  /** Max model round-trips before the loop stops. Default 50. */
  maxSteps?: number;
  /** Extra stop conditions (OR'ed with stepCountIs(maxSteps)). */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  /** Per-step overrides (swap model, prune messages, restrict tools). */
  prepareStep?: PrepareStepFunction<ToolSet>;
  /** Observer called after every step — for logging / telemetry. */
  onStep?: (step: StepResult<ToolSet>) => void;
  /** Observer called for every tool call after it executes. */
  onToolCall?: (record: ToolCallRecord) => void;
  /** Where `› tool input` lines go. Defaults to stdout; pass null to silence. */
  logger?: ((line: string) => void) | null;
  abortSignal?: AbortSignal;
  /** Passed through to the model call (temperature, maxOutputTokens, ...). */
  settings?: Omit<CallSettings, 'abortSignal'>;
}

export interface Harness {
  run(prompt: string | ModelMessage[]): Promise<HarnessResult>;
}

function defaultLogger(line: string): void {
  process.stdout.write(line + '\n');
}

function summarizeInput(input: unknown, max = 120): string {
  const s = typeof input === 'string' ? input : (JSON.stringify(input) ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Minimal agent harness on the Vercel AI SDK — same shape as pi-code:
 * a model, a system prompt, a small toolset, and a loop that runs until
 * the model stops calling tools (or maxSteps hits).
 *
 * The harness is intentionally dumb about git/PRs/pipeline state — callers
 * orchestrate those around `run()`. To add capabilities, merge more tools
 * into `options.tools`.
 */
export function createHarness(options: HarnessOptions): Harness {
  const {
    model,
    system,
    tools,
    maxSteps = 50,
    stopWhen,
    prepareStep,
    onStep,
    onToolCall,
    abortSignal,
    settings,
  } = options;
  const log = options.logger === null ? () => {} : (options.logger ?? defaultLogger);

  async function run(prompt: string | ModelMessage[]): Promise<HarnessResult> {
    const toolCalls: ToolCallRecord[] = [];

    const result = await generateText({
      model,
      system,
      tools,
      ...(typeof prompt === 'string' ? { prompt } : { messages: prompt }),
      stopWhen: [
        stepCountIs(maxSteps),
        ...(Array.isArray(stopWhen) ? stopWhen : stopWhen ? [stopWhen] : []),
      ],
      abortSignal,
      ...(settings ?? {}),
      ...(prepareStep ? { prepareStep } : {}),
      onStepFinish(step) {
        const pending = new Map<string, ToolCallRecord>();
        for (const tc of step.toolCalls) {
          log(`› ${tc.toolName} ${summarizeInput(tc.input)}`);
          const rec: ToolCallRecord = {
            step: step.stepNumber,
            toolName: tc.toolName,
            input: tc.input,
          };
          pending.set(tc.toolCallId, rec);
          toolCalls.push(rec);
        }
        for (const part of step.content) {
          if (part.type === 'tool-result' || part.type === 'tool-error') {
            const rec = pending.get(part.toolCallId);
            if (rec) {
              rec.isError = part.type === 'tool-error';
              rec.output = 'output' in part ? part.output : part.error;
            }
          }
        }
        for (const rec of pending.values()) onToolCall?.(rec);
        onStep?.(step);
      },
    });

    return {
      text: result.text,
      steps: result.steps,
      toolCalls,
      totalUsage: result.totalUsage,
      finishReason: result.finishReason,
      responseMessages: result.response.messages,
      truncated: result.steps.length >= maxSteps && result.finishReason === 'tool-calls',
    };
  }

  return { run };
}

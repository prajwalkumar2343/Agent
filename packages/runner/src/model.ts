import { randomUUID } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { SharedV3ProviderOptions } from '@ai-sdk/provider';

/**
 * Trusted-zone LLM (orchestrator, github agent, spec generation, evals).
 *
 *   LLM_PROVIDER   anthropic | openrouter | opencode | opencode-go
 *                  (default: anthropic; opencode-go is the Zen Go
 *                  subscription tier at /zen/go/v1 — same key, session-gated)
 *   LLM_MODEL      model id override for whichever provider is selected
 *   LLM_REASONING_EFFORT  minimal | low | medium | high | xhigh ("very high"
 *                  also maps to xhigh) — forwarded as providerOptions
 *                  reasoningEffort where the endpoint supports it
 *   ANTHROPIC_MODEL  still honored when LLM_PROVIDER=anthropic (back-compat)
 *   *_API_KEY      ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENCODE_API_KEY
 *
 * OpenCode Zen serves different model families over different API shapes
 * (opencode.ai/docs/zen): claude-* and qwen-* over the Anthropic messages
 * endpoint; gpt-*, grok-*, and muse-* over the OpenAI responses endpoint;
 * everything else (kimi, glm, minimax, deepseek, big-pickle, …) over OpenAI
 * chat/completions. Zen's *-free models (e.g. muse-spark-1.3-contributor-free)
 * are gated on an OpenCode session — x-opencode-session plus an opencode/*
 * user-agent, which we send on all Zen requests (paid models ignore them).
 */

export const LLM_PROVIDERS = ['anthropic', 'openrouter', 'opencode', 'opencode-go'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const KEY_ENV: Record<LlmProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
};

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openrouter: 'anthropic/claude-sonnet-4.5',
  opencode: 'claude-sonnet-4-5',
  'opencode-go': 'muse-spark-1.3-contributor',
};

/** Cheaper tier — the eval judge's default. */
const DEFAULT_CHEAP_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openrouter: 'anthropic/claude-haiku-4.5',
  opencode: 'claude-haiku-4-5',
  'opencode-go': 'muse-spark-1.3-contributor',
};

const ZEN_BASE = 'https://opencode.ai/zen/v1';
const ZEN_GO_BASE = 'https://opencode.ai/zen/go/v1';

/** Stable Zen/Go session id — Go requires it on every request (provider
 *  pinning + prompt caching); free-tier models are gated on it + the UA. */
const ZEN_SESSION = randomUUID();
const ZEN_HEADERS: Record<string, string> = {
  'x-opencode-session': ZEN_SESSION,
  'x-opencode-client': 'cli',
  'User-Agent': 'opencode/1.18.16',
};

/** Zen model families served over the OpenAI responses endpoint. */
const ZEN_RESPONSES = /^(gpt|grok|muse)/i;

const EFFORT_ALIAS: Record<string, string> = { 'very-high': 'xhigh', 'very high': 'xhigh' };
let warnedEffort = false;

/** Normalized LLM_REASONING_EFFORT value, or undefined when unset. */
export function llmReasoningEffort(): string | undefined {
  const raw = (process.env.LLM_REASONING_EFFORT ?? '').trim().toLowerCase();
  return raw ? (EFFORT_ALIAS[raw] ?? raw) : undefined;
}

/**
 * providerOptions for trusted-zone model calls — currently just reasoning
 * effort (LLM_REASONING_EFFORT). Only Zen's responses-endpoint models accept
 * reasoningEffort; for anything else the setting is ignored with a one-time
 * warning rather than silently dropped.
 */
export function modelProviderOptions(
  opts: { model?: string; cheap?: boolean } = {},
): SharedV3ProviderOptions | undefined {
  const effort = llmReasoningEffort();
  if (!effort) return undefined;
  const provider = llmProvider();
  const model = llmModelId(opts);
  if ((provider === 'opencode' || provider === 'opencode-go') && ZEN_RESPONSES.test(model)) {
    // forceReasoning: the SDK's model table doesn't know zen-only ids (muse-*,
    // grok-build-*, …) and would drop `reasoning` from the request otherwise.
    return { openai: { reasoningEffort: effort, forceReasoning: true } };
  }
  if (!warnedEffort) {
    warnedEffort = true;
    process.stderr.write(
      `LLM_REASONING_EFFORT=${effort} ignored — no reasoning mapping for ${provider}/${model}\n`,
    );
  }
  return undefined;
}

/** Selected trusted-zone provider; '' (unset Actions var) counts as unset. */
export function llmProvider(): LlmProvider {
  const p = (process.env.LLM_PROVIDER || 'anthropic') as LlmProvider;
  if (!LLM_PROVIDERS.includes(p)) {
    throw new Error(`unknown LLM_PROVIDER: ${p} (expected ${LLM_PROVIDERS.join('|')})`);
  }
  return p;
}

/** The model id the trusted zone will use — for trace/model_id fields. */
export function llmModelId(opts: { model?: string; cheap?: boolean } = {}): string {
  const provider = llmProvider();
  return (
    opts.model ||
    process.env.LLM_MODEL ||
    (provider === 'anthropic' ? process.env.ANTHROPIC_MODEL : undefined) ||
    (opts.cheap ? DEFAULT_CHEAP_MODEL[provider] : undefined) ||
    DEFAULT_MODEL[provider]
  );
}

/**
 * Resolve the trusted-zone model from env. `opts.model` is a caller-level
 * override (e.g. JUDGE_MODEL); `opts.cheap` picks the cheaper per-provider
 * default when no override applies.
 */
export function modelFromEnv(opts: { model?: string; cheap?: boolean } = {}): LanguageModel {
  const provider = llmProvider();
  const model = llmModelId(opts);
  const keyEnv = KEY_ENV[provider];
  const apiKey = process.env[keyEnv];
  if (!apiKey) throw new Error(`${keyEnv} is required for LLM_PROVIDER=${provider}`);
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'openrouter':
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
      })(model);
    case 'opencode':
    case 'opencode-go': {
      const zenBase = provider === 'opencode-go' ? ZEN_GO_BASE : ZEN_BASE;
      if (/^(claude|qwen)/i.test(model)) {
        return createAnthropic({ apiKey, baseURL: zenBase, headers: ZEN_HEADERS })(model);
      }
      if (ZEN_RESPONSES.test(model)) {
        return createOpenAI({ apiKey, baseURL: zenBase, headers: ZEN_HEADERS })(model);
      }
      return createOpenAICompatible({
        name: 'opencode',
        baseURL: zenBase,
        apiKey,
        headers: ZEN_HEADERS,
      })(model);
    }
  }
}

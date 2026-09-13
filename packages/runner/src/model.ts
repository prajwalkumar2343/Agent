import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/**
 * Trusted-zone LLM (orchestrator, github agent, spec generation, evals).
 *
 *   LLM_PROVIDER   anthropic | openrouter | opencode (default: anthropic)
 *   LLM_MODEL      model id override for whichever provider is selected
 *   ANTHROPIC_MODEL  still honored when LLM_PROVIDER=anthropic (back-compat)
 *   *_API_KEY      ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENCODE_API_KEY
 *
 * OpenCode Zen serves different model families over different API shapes
 * (opencode.ai/docs/zen): claude-* and qwen-* over the Anthropic messages
 * endpoint, gpt-* and grok-* over the OpenAI responses endpoint, everything
 * else (kimi, glm, minimax, …) over OpenAI chat/completions.
 */

export const LLM_PROVIDERS = ['anthropic', 'openrouter', 'opencode'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

const KEY_ENV: Record<LlmProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  opencode: 'OPENCODE_API_KEY',
};

const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openrouter: 'anthropic/claude-sonnet-4.5',
  opencode: 'claude-sonnet-4-5',
};

/** Cheaper tier — the eval judge's default. */
const DEFAULT_CHEAP_MODEL: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openrouter: 'anthropic/claude-haiku-4.5',
  opencode: 'claude-haiku-4-5',
};

const ZEN_BASE = 'https://opencode.ai/zen/v1';

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
      if (/^(claude|qwen)/i.test(model)) {
        return createAnthropic({ apiKey, baseURL: ZEN_BASE })(model);
      }
      if (/^(gpt|grok)/i.test(model)) {
        return createOpenAI({ apiKey, baseURL: ZEN_BASE })(model);
      }
      return createOpenAICompatible({ name: 'opencode', baseURL: ZEN_BASE, apiKey })(model);
  }
}

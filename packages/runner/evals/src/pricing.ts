import type { UsageTotals } from '../../src/trace.ts';

/**
 * $/MTok by model id — used to compute cost at run time from recorded usage,
 * including cache-read/creation tokens (they're billed differently; ignoring
 * them understates real cost). Update when Anthropic reprices; unknown models
 * fall back to the sonnet tier so cost is never silently zero.
 */

interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

const PRICES: Record<string, Price> = {
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-opus-4-5': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4-1': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cache_read: 0.08, cache_write: 1.0 },
  'eval-scripted': { input: 0, output: 0, cache_read: 0, cache_write: 0 },
};

const FALLBACK = PRICES['claude-sonnet-4-5']!;

export function costUsd(modelId: string | undefined, u: UsageTotals): number {
  const p = (modelId && PRICES[modelId]) || FALLBACK;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_tokens * p.cache_read +
      u.cache_creation_tokens * p.cache_write) /
    1e6
  );
}

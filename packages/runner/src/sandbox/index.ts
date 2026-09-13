import { E2BSandboxProvider } from './e2b.ts';
import { LocalSandboxProvider } from './local.ts';
import type { SandboxProvider } from './types.ts';

export * from './types.ts';
export { E2BSandboxProvider } from './e2b.ts';
export { LocalSandboxProvider } from './local.ts';

/** Provider env var pi reads for its LLM key, per provider. */
const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

/** pi's default model per provider — ids differ across gateways. */
const DEFAULT_PI_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openrouter: 'anthropic/claude-sonnet-4.5',
  opencode: 'claude-sonnet-4-5',
};

/**
 * Build the sandbox provider from env:
 *
 *   SANDBOX_PROVIDER   e2b | local (default: e2b when E2B_API_KEY set, else local)
 *   E2B_API_KEY        e2b auth
 *   E2B_TEMPLATE       e2b template (default 'base' — bootstrap installs node+pi)
 *   PI_PROVIDER        pi's LLM provider (default 'anthropic') — anthropic,
 *                      openai, google, openrouter, opencode, groq, mistral, …
 *   PI_MODEL           pi's model (default: per-provider table; $ANTHROPIC_MODEL
 *                      is still honored for PI_PROVIDER=anthropic)
 *   PI_API_KEY         key handed to pi inside the sandbox — the ONLY secret
 *                      that crosses the boundary (default: the provider's own
 *                      key var — ANTHROPIC_API_KEY, OPENROUTER_API_KEY,
 *                      OPENCODE_API_KEY, …)
 */
export function sandboxFromEnv(opts: { repoDir: string }): SandboxProvider {
  const piProvider = process.env.PI_PROVIDER || 'anthropic';
  const keyEnv = KEY_ENV[piProvider] ?? `${piProvider.toUpperCase()}_API_KEY`;
  const model =
    process.env.PI_MODEL ||
    (piProvider === 'anthropic' ? process.env.ANTHROPIC_MODEL : undefined) ||
    DEFAULT_PI_MODEL[piProvider] ||
    'claude-sonnet-4-5';
  const key = process.env.PI_API_KEY || process.env[keyEnv];
  if (!key) throw new Error(`PI_API_KEY (or ${keyEnv} for PI_PROVIDER=${piProvider}) is required`);

  const env = { [keyEnv]: key };
  const pi = { provider: piProvider, model };

  const name = process.env.SANDBOX_PROVIDER || (process.env.E2B_API_KEY ? 'e2b' : 'local');
  if (name === 'e2b') return new E2BSandboxProvider({ repoDir: opts.repoDir, env, pi });
  if (name === 'local') return new LocalSandboxProvider({ repoDir: opts.repoDir, env, pi });
  throw new Error(`unknown SANDBOX_PROVIDER: ${name} (expected e2b|local)`);
}

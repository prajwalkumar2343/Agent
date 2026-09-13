import { E2BSandboxProvider } from './e2b.ts';
import { LocalSandboxProvider } from './local.ts';
import type { SandboxGitTarget, SandboxProvider } from './types.ts';
import { secretRef, type SecretRef, type SecretVault } from '../../../shared/src/vault.ts';

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
  openai: 'gpt-4o',
  google: 'gemini-2.5-pro',
  openrouter: 'anthropic/claude-sonnet-4.5',
  opencode: 'claude-sonnet-4-5',
  'opencode-go': 'kimi-k2',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest',
};

/** The env var pi's provider reads for its LLM key (e.g. ANTHROPIC_API_KEY). */
export function piKeyEnvName(
  provider: string = process.env.PI_PROVIDER || 'anthropic',
): string {
  return KEY_ENV[provider] ?? `${provider.toUpperCase()}_API_KEY`;
}

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
 *   PI_API_KEY         key handed to pi inside the sandbox (default: the
 *                      provider's own key var — ANTHROPIC_API_KEY,
 *                      OPENROUTER_API_KEY, OPENCODE_API_KEY, …). Crosses as a
 *                      vault keyword; the value materializes at process spawn
 *                      inside the VM.
 *   GH_AGENT_PAT       product-repo PAT — crosses into the sandbox as
 *                      `GH_TOKEN` when `git` is passed; pi spends it on
 *                      pushing its fixed feature branch + opening the PR.
 */
export function sandboxFromEnv(opts: {
  repoDir: string;
  vault?: SecretVault;
  /** Remote-write target pi owns — when set, `GH_TOKEN` crosses the boundary. */
  git?: SandboxGitTarget;
}): SandboxProvider {
  const piProvider = process.env.PI_PROVIDER || 'anthropic';
  const keyEnv = piKeyEnvName(piProvider);
  const model =
    process.env.PI_MODEL ||
    (piProvider === 'anthropic' ? process.env.ANTHROPIC_MODEL : undefined) ||
    DEFAULT_PI_MODEL[piProvider];
  if (!model) {
    // No silent cross-provider fallback — a claude-* id would fail under e.g.
    // PI_PROVIDER=openai. Callers must set PI_MODEL for unknown providers.
    throw new Error(
      `no default pi model for PI_PROVIDER=${piProvider} — set PI_MODEL explicitly`,
    );
  }
  // The keyword pi's key resolves from — PI_API_KEY when set, else the
  // provider's own var. Presence check only; the value never leaves the vault.
  const srcName = process.env.PI_API_KEY ? 'PI_API_KEY' : keyEnv;
  if (!process.env[srcName]) {
    throw new Error(`PI_API_KEY (or ${keyEnv} for PI_PROVIDER=${piProvider}) is required`);
  }

  const envRefs: Record<string, SecretRef> = { [keyEnv]: secretRef(srcName) };
  if (opts.git) {
    // pi owns the remote write — the PAT crosses the boundary as GH_TOKEN.
    envRefs.GH_TOKEN = secretRef('GH_AGENT_PAT');
  }
  const pi = { provider: piProvider, model };

  const name = process.env.SANDBOX_PROVIDER || (process.env.E2B_API_KEY ? 'e2b' : 'local');
  const common = {
    repoDir: opts.repoDir,
    envRefs,
    pi,
    vault: opts.vault,
    git: opts.git,
  };
  if (name === 'e2b') return new E2BSandboxProvider(common);
  if (name === 'local') return new LocalSandboxProvider(common);
  throw new Error(`unknown SANDBOX_PROVIDER: ${name} (expected e2b|local)`);
}

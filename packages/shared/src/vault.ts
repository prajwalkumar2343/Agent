/**
 * Secret vault — the only place pipeline env vars materialize into values.
 *
 * Secrets live in the vault (the deployment env: Vercel env vars / Actions
 * secrets, or an explicit map in tests). Everything agent-adjacent — tool
 * contexts, provider configs, the sandbox env spec — carries SecretRef
 * keywords (`vault:NAME`), never values. A ref resolves inside a tool
 * implementation at the exact boundary where the secret is spent: an
 * Authorization header, a child-process spawn, a callback header. Context
 * objects are therefore safe to trace, log, or hold in agent-reachable
 * memory, and a raw value passed where a ref is expected fails loudly.
 *
 * There is intentionally no tool that resolves a ref into model context —
 * agents can only *use* variables as keywords; values never come back.
 */

export type SecretRef = `vault:${string}`;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REF = /^vault:([A-Za-z_][A-Za-z0-9_]*)$/;

/** `secretRef('GH_AGENT_PAT')` → `vault:GH_AGENT_PAT` — the keyword form. */
export function secretRef(name: string): SecretRef {
  if (!NAME.test(name)) throw new Error(`bad secret name: ${name}`);
  return `vault:${name}`;
}

export function isSecretRef(v: unknown): v is SecretRef {
  return typeof v === 'string' && REF.test(v);
}

/** The env-var name a ref points at. Raw values are rejected here. */
export function secretName(ref: SecretRef): string {
  const m = typeof ref === 'string' ? REF.exec(ref) : null;
  if (!m) {
    throw new Error(
      'expected a vault reference (vault:NAME) — secrets are referenced as keywords, never passed as values',
    );
  }
  return m[1]!;
}

export interface SecretVault {
  /** True when the vault holds a non-empty value for this keyword. */
  has(name: string): boolean;
  /** The keyword names this vault can resolve — the closed surface. */
  names(): string[];
  /**
   * Keyword → value. Trusted-zone call only: inside tool implementations,
   * never in code paths whose output reaches a model or a subprocess env
   * the agent controls beyond the intended injection point.
   */
  resolve(ref: SecretRef): string;
}

/**
 * Vault over an env record — default `process.env`. `allow` scopes the
 * resolvable keyword space: a vault built with `['GH_AGENT_PAT']` refuses
 * every other name, so even a ref smuggled in by a caller bug (or a
 * prompt-injected string) can only ever name declared secrets.
 */
export function envVault(
  env: NodeJS.ProcessEnv = process.env,
  allow?: readonly string[],
): SecretVault {
  const scope = allow ? new Set(allow) : null;
  return {
    has: (name) =>
      Object.hasOwn(env, name) && Boolean(env[name]) && (!scope || scope.has(name)),
    names: () =>
      scope ? [...scope] : Object.keys(env).filter((k) => Boolean(env[k])),
    resolve(ref) {
      const name = secretName(ref);
      if (scope && !scope.has(name)) {
        throw new Error(`vault:${name} is outside this vault's scope`);
      }
      const v = env[name];
      if (!Object.hasOwn(env, name) || !v) {
        throw new Error(`vault: no value for ${name} (env var unset)`);
      }
      return v;
    },
  };
}

/** Vault over an explicit map — scoped to exactly its keys. For tests/mocks. */
export function mapVault(secrets: Record<string, string>): SecretVault {
  return envVault(secrets, Object.keys(secrets));
}

/**
 * Resolve a `{ envName: ref }` spec into a plain env record at the last
 * possible boundary (e.g. a process spawn). The result must go straight
 * into the spawn call — never stored on shared state, never logged.
 */
export function resolveSecrets(
  refs: Record<string, SecretRef>,
  vault: SecretVault,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [envName, ref] of Object.entries(refs)) {
    out[envName] = vault.resolve(ref);
  }
  return out;
}

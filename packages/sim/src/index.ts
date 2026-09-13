import { createMockProvider } from './providers/mock.ts';
import { createMcpProvider, simMcpConfigFromEnv } from './providers/mcp.ts';
import type { SimProvider } from './provider.ts';

export * from './provider.ts';
export { createMockProvider, createMcpProvider, simMcpConfigFromEnv };

const REGISTRY: Record<string, (env: NodeJS.ProcessEnv) => SimProvider> = {
  mock: () => createMockProvider(),
  mcp: (env) => createMcpProvider(simMcpConfigFromEnv(env)),
};

/**
 * Resolve the configured provider. Unknown names fail loudly at the boundary
 * listing valid options, never silently fall back.
 */
export function getSimProvider(env: NodeJS.ProcessEnv = process.env): SimProvider {
  const name = env.SIM_PROVIDER ?? 'mock';
  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(`unknown SIM_PROVIDER "${name}" — expected one of: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return factory(env);
}

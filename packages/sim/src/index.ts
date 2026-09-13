import { createMockProvider } from './providers/mock.ts';
import type { SimProvider } from './provider.ts';

export * from './provider.ts';
export { createMockProvider };

const REGISTRY: Record<string, () => SimProvider> = {
  mock: createMockProvider,
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
  return factory();
}

import type { SimReport } from '../../../shared/src/index.ts';
import type { SimInput, SimProvider } from '../provider.ts';

const PERSONAS = ['power-user', 'new-user', 'admin'] as const;

/**
 * Deterministic stand-in so the pipeline is demoable end-to-end before a real
 * simulation tool is chosen (SIM_PROVIDER=mock ships by default). Reactions
 * are derived from the spec so reports are stable across identical runs.
 */
export function createMockProvider(): SimProvider {
  return {
    name: 'mock',
    async simulate(input: SimInput): Promise<SimReport> {
      const reactions = PERSONAS.map((persona, i) => ({
        persona,
        reaction:
          input.spec.acceptance[i] != null
            ? `Would try "${input.spec.title}" for: ${input.spec.acceptance[i]}`
            : `Neutral on "${input.spec.title}"`,
        sentiment: (i === 0 ? 1 : 0) as -1 | 0 | 1,
      }));
      return {
        verdict: 'ship',
        confidence: 0.5,
        summary:
          `Mock simulation of "${input.spec.title}": ${input.spec.acceptance.length} ` +
          'acceptance criteria, no real audience data. Swap SIM_PROVIDER for a real tool.',
        persona_reactions: reactions,
        evidence_links: input.pr_url ? [input.pr_url] : [],
      };
    },
  };
}

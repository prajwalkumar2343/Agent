import type { SimReport } from '../../../shared/src/index.ts';
import {
  createOutsetMcp,
  outsetMcpConfigFromEnv,
  type OutsetMcpConfig,
} from '../../../outset/src/mcp.ts';
import type { SimInput, SimProvider } from '../provider.ts';

export { outsetMcpConfigFromEnv };
export type { OutsetMcpConfig };

/**
 * SimProvider backed by the Outset app — the pipeline calls its
 * `analyze_feature` tool and gets a SimReport back. Selected via
 * SIM_PROVIDER=outset + OUTSET_API_URL. Speaks the same tool shape as the
 * bundled mock (packages/sim/src/mcp/server.ts), so the mock server doubles
 * as the local stand-in for this provider in tests.
 */
export function outsetSimConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OutsetMcpConfig {
  return outsetMcpConfigFromEnv(env);
}

const VERDICTS = new Set(['ship', 'iterate', 'drop']);

function assertSimReport(raw: unknown): asserts raw is SimReport {
  const r = raw as SimReport;
  if (r == null || typeof r !== 'object') throw new Error('outset sim: response is not an object');
  if (!VERDICTS.has(r.verdict)) throw new Error(`outset sim: bad verdict "${r.verdict}"`);
  if (!Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) {
    throw new Error(`outset sim: bad confidence ${r.confidence}`);
  }
  if (typeof r.summary !== 'string') throw new Error('outset sim: missing summary');
  if (!Array.isArray(r.persona_reactions)) throw new Error('outset sim: missing persona_reactions');
  for (const p of r.persona_reactions) {
    if (p == null || typeof p !== 'object' || typeof p.persona !== 'string' || typeof p.reaction !== 'string') {
      throw new Error('outset sim: persona_reactions entries need {persona, reaction} strings');
    }
    if (p.sentiment !== -1 && p.sentiment !== 0 && p.sentiment !== 1) {
      throw new Error(`outset sim: bad sentiment ${p.sentiment}`);
    }
  }
}

export function createOutsetProvider(config: OutsetMcpConfig): SimProvider {
  const mcp = createOutsetMcp(config);
  return {
    name: 'outset',
    async simulate(input: SimInput): Promise<SimReport> {
      const raw = await mcp.callTool('analyze_feature', {
        spec: input.spec,
        feature_check: input.feature_check,
        evidence: input.evidence,
        pr_url: input.pr_url,
      });
      assertSimReport(raw);
      return raw;
    },
  };
}

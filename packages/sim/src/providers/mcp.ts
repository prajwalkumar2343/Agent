import type { SimReport } from '../../../shared/src/index.ts';
import type { SimInput, SimProvider } from '../provider.ts';
import { createSimMcp, type SimMcpConfig } from '../mcp/client.ts';

/**
 * SimProvider backed by an external MCP app — the agent calls its
 * `analyze_feature` tool and gets a SimReport back. Selected via
 * SIM_PROVIDER=mcp + SIM_API_URL. Works unchanged against the bundled mock
 * (packages/sim/src/mcp/server.ts) today and a real audience tool later;
 * the agent cannot tell the difference.
 */
export function simMcpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SimMcpConfig {
  const url = env.SIM_API_URL;
  if (!url) {
    throw new Error('SIM_PROVIDER=mcp requires SIM_API_URL (e.g. http://127.0.0.1:4100/mcp)');
  }
  return { url, apiKey: env.SIM_API_KEY || undefined };
}

const VERDICTS = new Set(['ship', 'iterate', 'drop']);

function assertSimReport(raw: unknown): asserts raw is SimReport {
  const r = raw as SimReport;
  if (r == null || typeof r !== 'object') throw new Error('sim mcp: response is not an object');
  if (!VERDICTS.has(r.verdict)) throw new Error(`sim mcp: bad verdict "${r.verdict}"`);
  if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
    throw new Error(`sim mcp: bad confidence ${r.confidence}`);
  }
  if (typeof r.summary !== 'string') throw new Error('sim mcp: missing summary');
  if (!Array.isArray(r.persona_reactions)) throw new Error('sim mcp: missing persona_reactions');
}

export function createMcpProvider(config: SimMcpConfig): SimProvider {
  const mcp = createSimMcp(config);
  return {
    name: 'mcp',
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

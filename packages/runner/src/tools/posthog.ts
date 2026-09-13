import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
// Cross-package import: packages/posthog owns the MCP transport (mcp.ts); the
// runner is allowed to reach it the same way api/ handlers do — relative path.
import {
  createPostHogMcp,
  type McpTool,
  type PostHogMcpConfig,
} from '../../../posthog/src/mcp.ts';

const MAX_OUT = 8_000;

/**
 * The coding agent's PostHog scope: everything needed for evidence reads and
 * flag management, without org/admin surfaces (switch-*, workspace, billing).
 */
const AGENT_FEATURES = [
  'flags',
  'events',
  'sql',
  'data_schema',
  'insights',
  'search',
  'docs',
  'replay',
  'error_tracking',
];

/** Writes the agent may legitimately make are flag creates/updates — never deletes or context switches. */
const DENIED = /delete|bulk|archive|switch-/i;

const USAGE = `commands:
  tools                      list every tool this PostHog session exposes
  search <regex>             find tools by name/description
  info <tool>                show a tool's description + input schema
  schema <tool> <path>       drill into one field of a schema (dot path)
  call <tool> <json>         call a tool — e.g. call execute-sql {"query":"SELECT ..."}`;

const clip = (s: string): string =>
  s.length > MAX_OUT ? s.slice(0, MAX_OUT) + '…[truncated]' : s;

const drill = (schema: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => {
    if (!node || typeof node !== 'object') return undefined;
    const o = node as Record<string, unknown>;
    return (o.properties as Record<string, unknown> | undefined)?.[key] ?? o[key];
  }, schema);

/**
 * PostHog access for the main agent, as ONE tool — a small dispatcher over the
 * MCP session's tool list (same shape as PostHog's own CLI mode). The agent
 * discovers tools with search/info and invokes them with call, so hundreds of
 * tool schemas never sit in context. The API key stays inside the tool impl.
 */
export function posthogTools(config: PostHogMcpConfig): ToolSet {
  const ph = createPostHogMcp({ features: AGENT_FEATURES, ...config });
  let toolsPromise: Promise<McpTool[]> | null = null;
  const list = () => (toolsPromise ??= ph.listTools());

  async function exec(command: string): Promise<string> {
    const m = /^\s*([a-zA-Z_-]+)\s*([\s\S]*)$/.exec(command);
    const cmd = m?.[1]?.toLowerCase();
    const rest = m?.[2]?.trim() ?? '';
    try {
      switch (cmd) {
        case 'tools': {
          const tools = await list();
          return clip(tools.map((t) => t.name).join('\n') || 'no tools');
        }
        case 'search': {
          if (!rest) return 'usage: search <regex>';
          let re: RegExp;
          try {
            re = new RegExp(rest, 'i');
          } catch {
            return `bad regex: ${rest}`;
          }
          const hits = (await list()).filter(
            (t) => re.test(t.name) || re.test(t.description ?? ''),
          );
          return clip(
            hits.map((t) => `${t.name} — ${(t.description ?? '').split('\n')[0]}`).join('\n') ||
              'no matches',
          );
        }
        case 'info': {
          const t = (await list()).find((t) => t.name === rest);
          if (!t) return `unknown tool "${rest}" — try search`;
          return clip(
            JSON.stringify(
              { name: t.name, description: t.description, inputSchema: t.inputSchema },
              null,
              2,
            ),
          );
        }
        case 'schema': {
          const sp = rest.indexOf(' ');
          const [name, path] = sp === -1 ? [rest, ''] : [rest.slice(0, sp), rest.slice(sp + 1).trim()];
          const t = (await list()).find((t) => t.name === name);
          if (!t) return `unknown tool "${name}" — try search`;
          return clip(JSON.stringify(path ? drill(t.inputSchema, path) : t.inputSchema, null, 2));
        }
        case 'call': {
          const sp = rest.indexOf(' ');
          const name = sp === -1 ? rest : rest.slice(0, sp);
          const argText = sp === -1 ? '' : rest.slice(sp + 1).trim();
          if (!name) return `usage: call <tool> <json>`;
          const t = (await list()).find((t) => t.name === name);
          if (!t) return `unknown tool "${name}" — try search`;
          if (DENIED.test(name)) return `tool "${name}" is disabled for this agent`;
          let args: Record<string, unknown> = {};
          if (argText) {
            try {
              args = JSON.parse(argText) as Record<string, unknown>;
            } catch {
              return `call: invalid JSON input — ${argText.slice(0, 200)}`;
            }
          }
          const out = await ph.callTool(name, args);
          return clip(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
        }
        default:
          return USAGE;
      }
    } catch (err) {
      return `posthog error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    posthog: tool({
      description:
        'Query and manage the PostHog project via its MCP server. Pass a command string:\n' +
        USAGE +
        '\nUseful tools: execute-sql (HogQL over events), feature-flag-get-all, ' +
        'feature-flag-get-definition-by-key, create-feature-flag, update-feature-flag, ' +
        'query-session-recordings-list, insights-list, read-data-schema, docs-search. ' +
        'info a tool before calling it — never guess a schema.',
      inputSchema: z.object({
        command: z.string().describe('e.g. "search flag", "info execute-sql", or "call <tool> <json>"'),
      }),
      execute: async ({ command }) => exec(command),
    }),
  };
}

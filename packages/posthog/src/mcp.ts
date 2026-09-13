import {
  envVault,
  secretRef,
  type SecretRef,
  type SecretVault,
} from '../../shared/src/vault.ts';

/**
 * PostHog MCP transport — every PostHog capability the pipeline uses (event
 * taxonomy, HogQL evidence, flag mutations, metric pulls) goes through the
 * hosted MCP server as `tools/call`, so this is the only place auth/host are
 * wired. Speaks streamable-HTTP JSON-RPC: initialize handshake, session
 * headers, SSE-or-JSON responses.
 */

export interface PostHogMcpConfig {
  /**
   * Personal API key as a vault keyword (e.g. `vault:POSTHOG_API_KEY`) —
   * PostHog "MCP Server" preset (phx_…), project-scoped. The value is
   * resolved per request inside `headers()`; it never sits on the config.
   */
  apiKeyRef: SecretRef;
  /** Vault that resolves `apiKeyRef` — default: the process env vault. */
  vault?: SecretVault;
  /** Endpoint. Defaults to https://mcp.posthog.com/mcp (region auto-routed). */
  url?: string;
  /** Pin the session to a project (x-posthog-project-id) — keeps writes aimed at one project. */
  projectId?: string;
  /** ?features= allowlist, e.g. ['flags','sql','events']. Default: everything the key can see. */
  features?: string[];
  /** x-posthog-read-only — strips write tools from the session. */
  readOnly?: boolean;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export function posthogMcpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  vault?: SecretVault,
): PostHogMcpConfig {
  if (!env.POSTHOG_API_KEY) throw new Error('Missing required env var: POSTHOG_API_KEY');
  return {
    apiKeyRef: secretRef('POSTHOG_API_KEY'),
    vault: vault ?? envVault(env),
    url: env.POSTHOG_MCP_URL || undefined,
    projectId: env.POSTHOG_PROJECT_ID || undefined,
    features: env.POSTHOG_MCP_FEATURES?.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface PostHogMcp {
  /** tools/list — every tool the session exposes (follows cursors). */
  listTools(): Promise<McpTool[]>;
  /**
   * tools/call — returns structuredContent when the server sends it, else the
   * joined text payload parsed as JSON when possible, else raw text.
   */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** tools/call — always the joined text payload. Throws when isError. */
  callToolText(name: string, args?: Record<string, unknown>): Promise<string>;
}

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'platform-agent', version: '0.0.0' };
const DEFAULT_URL = 'https://mcp.posthog.com/mcp';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

class PostHogMcpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PostHogMcpError';
    this.status = status;
  }
}

/** A streamable-HTTP response body is either one JSON-RPC doc or SSE frames (`data:` lines). */
function parseBody(text: string, contentType: string): JsonRpcMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (!contentType.includes('text/event-stream') && !trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    const doc = JSON.parse(trimmed) as JsonRpcMessage | JsonRpcMessage[];
    return Array.isArray(doc) ? doc : [doc];
  }
  const messages: JsonRpcMessage[] = [];
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (data) messages.push(JSON.parse(data) as JsonRpcMessage);
  }
  return messages;
}

export function createPostHogMcp(config: PostHogMcpConfig): PostHogMcp {
  const call = config.fetchFn ?? fetch;
  const vault = config.vault ?? envVault();
  const url = new URL(config.url ?? DEFAULT_URL);
  if (config.features?.length) url.searchParams.set('features', config.features.join(','));
  const endpoint = url.toString();

  let nextId = 0;
  let sessionId: string | undefined;
  let initPromise: Promise<void> | null = null;
  let toolsCache: McpTool[] | null = null;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${vault.resolve(config.apiKeyRef)}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-posthog-mcp-mode': 'tools',
    };
    if (config.projectId) h['x-posthog-project-id'] = config.projectId;
    if (config.readOnly) h['x-posthog-read-only'] = 'true';
    if (sessionId) {
      h['mcp-session-id'] = sessionId;
      h['mcp-protocol-version'] = PROTOCOL_VERSION;
    }
    return h;
  }

  /** One JSON-RPC round trip; resolves with the response message matching the request id. */
  async function send(method: string, params?: unknown, notify = false): Promise<JsonRpcMessage | null> {
    const id = notify ? undefined : ++nextId;
    const res = await call(endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new PostHogMcpError(`posthog mcp ${method} failed: ${res.status} ${detail}`.trim(), res.status);
    }
    if (notify || res.status === 202) return null;
    const messages = parseBody(await res.text(), res.headers.get('content-type') ?? '');
    const match = messages.find((m) => m.id === id) ?? (messages.length === 1 ? messages[0] : undefined);
    if (!match) throw new PostHogMcpError(`posthog mcp ${method}: no response message`);
    if (match.error) throw new PostHogMcpError(`posthog mcp ${method} error ${match.error.code}: ${match.error.message}`);
    return match;
  }

  function ensureInitialized(): Promise<void> {
    initPromise ??= (async () => {
      await send('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      await send('notifications/initialized', undefined, true);
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
    return initPromise;
  }

  /** Run `fn` after the handshake; on a dead session (404) re-initialize and retry once. */
  async function request<T>(fn: () => Promise<T>): Promise<T> {
    await ensureInitialized();
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof PostHogMcpError) || err.status !== 404) throw err;
      sessionId = undefined;
      initPromise = null;
      await ensureInitialized();
      return fn();
    }
  }

  function toolPayload(result: unknown): { text: string; structured?: unknown; isError: boolean } {
    const r = (result ?? {}) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
      structuredContent?: unknown;
    };
    return {
      text: (r.content ?? [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join('\n'),
      structured: r.structuredContent,
      isError: r.isError === true,
    };
  }

  async function callToolRaw(name: string, args: Record<string, unknown>) {
    const msg = await request(() => send('tools/call', { name, arguments: args }));
    const payload = toolPayload(msg?.result);
    if (payload.isError) {
      throw new PostHogMcpError(`posthog tool ${name} failed: ${payload.text || 'unknown error'}`);
    }
    return payload;
  }

  return {
    async listTools() {
      if (toolsCache) return toolsCache;
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const msg = await request(() =>
          send('tools/list', cursor ? { cursor } : {}),
        );
        const result = (msg?.result ?? {}) as { tools?: McpTool[]; nextCursor?: string };
        tools.push(...(result.tools ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      toolsCache = tools;
      return tools;
    },

    async callTool(name, args = {}) {
      const { text, structured } = await callToolRaw(name, args);
      if (structured !== undefined) return structured;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },

    async callToolText(name, args = {}) {
      return (await callToolRaw(name, args)).text;
    },
  };
}

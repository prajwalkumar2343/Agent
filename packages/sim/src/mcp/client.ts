/**
 * Streamable-HTTP MCP client for the audience-sim endpoint — same dialect as
 * packages/posthog/src/mcp.ts but generic: optional bearer auth, no
 * PostHog-specific headers. Used by the `mcp` SimProvider; works against the
 * bundled mock server today and a real sim tool later (same URL, same tools).
 */

export interface SimMcpConfig {
  /** MCP endpoint, e.g. http://127.0.0.1:4100/mcp */
  url: string;
  /** Optional bearer token (SIM_API_KEY). */
  apiKey?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface SimMcp {
  listTools(): Promise<McpTool[]>;
  /** Returns structuredContent when present, else text parsed as JSON, else raw text. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'platform-agent', version: '0.0.0' };

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export class SimMcpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SimMcpError';
    this.status = status;
  }
}

/** A streamable-HTTP body is one JSON-RPC doc or SSE frames (`data:` lines). */
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

export function createSimMcp(config: SimMcpConfig): SimMcp {
  const call = config.fetchFn ?? fetch;
  const endpoint = config.url;

  let nextId = 0;
  let sessionId: string | undefined;
  let initPromise: Promise<void> | null = null;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (config.apiKey) h.authorization = `Bearer ${config.apiKey}`;
    if (sessionId) {
      h['mcp-session-id'] = sessionId;
      h['mcp-protocol-version'] = PROTOCOL_VERSION;
    }
    return h;
  }

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
      throw new SimMcpError(`sim mcp ${method} failed: ${res.status} ${detail}`.trim(), res.status);
    }
    if (notify || res.status === 202) return null;
    const messages = parseBody(await res.text(), res.headers.get('content-type') ?? '');
    const match = messages.find((m) => m.id === id) ?? (messages.length === 1 ? messages[0] : undefined);
    if (!match) throw new SimMcpError(`sim mcp ${method}: no response message`);
    if (match.error) throw new SimMcpError(`sim mcp ${method} error ${match.error.code}: ${match.error.message}`);
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

  /** Retry once on a dead session (404 → re-handshake). */
  async function request<T>(fn: () => Promise<T>): Promise<T> {
    await ensureInitialized();
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof SimMcpError) || err.status !== 404) throw err;
      sessionId = undefined;
      initPromise = null;
      await ensureInitialized();
      return fn();
    }
  }

  return {
    async listTools() {
      const msg = await request(() => send('tools/list', {}));
      const result = (msg?.result ?? {}) as { tools?: McpTool[] };
      return result.tools ?? [];
    },

    async callTool(name, args = {}) {
      const msg = await request(() => send('tools/call', { name, arguments: args }));
      const r = (msg?.result ?? {}) as {
        content?: { type?: string; text?: string }[];
        isError?: boolean;
        structuredContent?: unknown;
      };
      const text = (r.content ?? [])
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
        .join('\n');
      if (r.isError) throw new SimMcpError(`sim tool ${name} failed: ${text || 'unknown error'}`);
      if (r.structuredContent !== undefined) return r.structuredContent;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },
  };
}

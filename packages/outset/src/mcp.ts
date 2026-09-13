import {
  envVault,
  secretRef,
  type SecretRef,
  type SecretVault,
} from '../../shared/src/vault.ts';

/**
 * Outset MCP transport — audience simulation over the Outset app's
 * streamable-HTTP MCP server. Same JSON-RPC dialect as the other MCP
 * transports in this repo (initialize handshake, session headers,
 * SSE-or-JSON responses): optional bearer auth, no vendor-specific headers
 * beyond the endpoint itself.
 */

export interface OutsetMcpConfig {
  /** MCP endpoint, e.g. https://<outset-app>/mcp */
  url: string;
  /** Optional bearer as a vault keyword (e.g. `vault:OUTSET_API_KEY`). */
  apiKeyRef?: SecretRef;
  /** Vault that resolves `apiKeyRef` — default: the process env vault. */
  vault?: SecretVault;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export function outsetMcpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  vault?: SecretVault,
): OutsetMcpConfig {
  const url = env.OUTSET_API_URL;
  if (!url) {
    throw new Error('SIM_PROVIDER=outset requires OUTSET_API_URL (e.g. https://<outset-app>/mcp)');
  }
  return {
    url,
    apiKeyRef: env.OUTSET_API_KEY ? secretRef('OUTSET_API_KEY') : undefined,
    vault: vault ?? envVault(env),
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface OutsetMcp {
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

export class OutsetMcpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OutsetMcpError';
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

export function createOutsetMcp(config: OutsetMcpConfig): OutsetMcp {
  const call = config.fetchFn ?? fetch;
  const vault = config.vault ?? envVault();
  const endpoint = config.url;

  let nextId = 0;
  let sessionId: string | undefined;
  let initPromise: Promise<void> | null = null;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (config.apiKeyRef) h.authorization = `Bearer ${vault.resolve(config.apiKeyRef)}`;
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
      throw new OutsetMcpError(`outset mcp ${method} failed: ${res.status} ${detail}`.trim(), res.status);
    }
    if (notify || res.status === 202) return null;
    const messages = parseBody(await res.text(), res.headers.get('content-type') ?? '');
    const match = messages.find((m) => m.id === id) ?? (messages.length === 1 ? messages[0] : undefined);
    if (!match) throw new OutsetMcpError(`outset mcp ${method}: no response message`);
    if (match.error) throw new OutsetMcpError(`outset mcp ${method} error ${match.error.code}: ${match.error.message}`);
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
      if (!(err instanceof OutsetMcpError) || err.status !== 404) throw err;
      sessionId = undefined;
      initPromise = null;
      await ensureInitialized();
      return fn();
    }
  }

  return {
    async listTools() {
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
      return tools;
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
      if (r.isError) throw new OutsetMcpError(`outset tool ${name} failed: ${text || 'unknown error'}`);
      if (r.structuredContent !== undefined) return r.structuredContent;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },
  };
}

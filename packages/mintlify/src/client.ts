/**
 * Mintlify docs MCP adapter (JSON-RPC 2.0 over POST). A5 owns the
 * feature-check composition; this is only the transport seam — endpoint,
 * envelopes, errors. If the docs site turns out to be private, swap this for
 * the authed MCP transport without changing callers (see docs/SETUP.md #7).
 */

export interface DocsClientConfig {
  /** DOCS_MCP_URL — e.g. https://<mintlify-site>/mcp */
  url: string;
  fetchFn?: typeof fetch;
}

export interface DocHit {
  title: string;
  url: string;
  snippet: string;
}

export interface DocsClient {
  search(query: string, limit?: number): Promise<DocHit[]>;
}

interface JsonRpcResponse {
  result?: { content?: { type: string; text?: string }[] };
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'platform-agent', version: '0.0.0' };

class DocsMcpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DocsMcpError';
    this.status = status;
  }
}

/** Extract the tool's text payload and parse embedded JSON when present. */
function toolText(json: JsonRpcResponse): string {
  if (json.error) throw new Error(`docs mcp error ${json.error.code}: ${json.error.message}`);
  return (json.result?.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}

export function createDocsClient(config: DocsClientConfig): DocsClient {
  const call = config.fetchFn ?? fetch;
  let id = 0;
  let sessionId: string | undefined;
  let initPromise: Promise<void> | null = null;

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) {
      h['mcp-session-id'] = sessionId;
      h['mcp-protocol-version'] = PROTOCOL_VERSION;
    }
    return h;
  }

  async function rpc<T>(method: string, params?: unknown, notify = false): Promise<T | null> {
    const reqId = notify ? undefined : ++id;
    const res = await call(config.url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(reqId !== undefined ? { id: reqId } : {}),
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (!res.ok) throw new DocsMcpError(`docs mcp ${method} failed: ${res.status}`, res.status);
    if (notify || res.status === 202) return null;
    const body = await res.text();
    // MCP servers may reply with SSE frames; the JSON-RPC doc rides in `data:`
    // lines — one doc per event, with a doc's JSON possibly split across
    // several `data:` lines in that event.
    const sse =
      (res.headers.get('content-type') ?? '').includes('text/event-stream') ||
      body.startsWith('event:') ||
      body.startsWith('data:');
    if (!sse) return JSON.parse(body) as T;
    const docs = body
      .split(/\r?\n\r?\n/)
      .map((block) =>
        block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n'),
      )
      .filter(Boolean)
      .map((d) => JSON.parse(d) as T & { id?: number | string });
    const match = docs.find((d) => d.id === reqId) ?? (docs.length === 1 ? docs[0] : undefined);
    if (!match) throw new DocsMcpError(`docs mcp ${method}: no response message`);
    return match;
  }

  /** The endpoint is a real MCP server — handshake once, then ride the session. */
  function ensureInitialized(): Promise<void> {
    initPromise ??= (async () => {
      const init = await rpc<JsonRpcResponse>('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      if (init?.error) {
        throw new Error(`docs mcp initialize error ${init.error.code}: ${init.error.message}`);
      }
      await rpc('notifications/initialized', undefined, true);
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
      if (!(err instanceof DocsMcpError) || err.status !== 404) throw err;
      sessionId = undefined;
      initPromise = null;
      await ensureInitialized();
      return fn();
    }
  }

  return {
    async search(query, limit = 5) {
      const json = await request(() =>
        rpc<JsonRpcResponse>('tools/call', {
          name: 'search',
          arguments: { query, limit },
        }),
      );
      const text = toolText(json ?? {});
      try {
        const parsed = JSON.parse(text) as { results?: DocHit[] } | DocHit[];
        return Array.isArray(parsed) ? parsed : (parsed.results ?? []);
      } catch {
        // Some MCP search tools return prose rather than JSON — surface it as
        // one snippet rather than failing the whole feature check.
        return text ? [{ title: 'docs search result', url: '', snippet: text.slice(0, 500) }] : [];
      }
    },
  };
}

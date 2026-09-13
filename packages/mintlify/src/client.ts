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

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await call(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    if (!res.ok) throw new Error(`docs mcp ${method} failed: ${res.status}`);
    const body = await res.text();
    // MCP servers may reply with SSE frames; the JSON-RPC doc rides in `data:`.
    const line = body.startsWith('event:')
      ? (body
          .split('\n')
          .find((l) => l.startsWith('data:'))
          ?.slice(5) ?? '')
      : body;
    return JSON.parse(line) as T;
  }

  return {
    async search(query, limit = 5) {
      const json = await rpc<JsonRpcResponse>('tools/call', {
        name: 'search',
        arguments: { query, limit },
      });
      const text = toolText(json);
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

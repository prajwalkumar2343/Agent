import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolSet } from 'ai';
import { posthogTools } from '../src/tools/posthog.ts';
import { mapVault, secretRef } from '../../shared/src/vault.ts';

const OPTS = { toolCallId: 't1', messages: [] };

/** Config carrying a vault keyword — never the key value. */
const cfg = (key: string, fetchFn: typeof fetch) => ({
  apiKeyRef: secretRef('POSTHOG_API_KEY'),
  vault: mapVault({ POSTHOG_API_KEY: key }),
  fetchFn,
});

const TOOLS = [
  { name: 'execute-sql', description: 'Execute an SQL query.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'feature-flag-get-all', description: 'Get all feature flags', inputSchema: { type: 'object' } },
  { name: 'create-feature-flag', description: 'Create feature flag', inputSchema: { type: 'object' } },
  { name: 'delete-feature-flag', description: 'Delete feature flag', inputSchema: { type: 'object' } },
];

/** Minimal MCP server double — handshake + tools/list + tools/call. */
function fakeFetch(calls: [string, Record<string, unknown>][] = []) {
  const respond = (id: unknown, result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' },
    });
  return (async (_url: unknown, init?: { body?: string }) => {
    const msg = JSON.parse(init?.body ?? '{}') as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (msg.method === 'initialize') return respond(msg.id, {});
    if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (msg.method === 'tools/list') return respond(msg.id, { tools: TOOLS });
    if (msg.method === 'tools/call') {
      calls.push([msg.params?.name ?? '', msg.params?.arguments ?? {}]);
      if (msg.params?.name === 'execute-sql') {
        return respond(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ results: [[42]] }) }],
        });
      }
      return respond(msg.id, { content: [{ type: 'text', text: '{}' }] });
    }
    return new Response('bad', { status: 400 });
  }) as unknown as typeof fetch;
}

async function exec(tools: ToolSet, command: string): Promise<string> {
  const t = tools.posthog!;
  assert.ok(t.execute);
  return (await t.execute({ command }, OPTS)) as string;
}

describe('posthog tool (MCP dispatcher)', () => {
  it('exposes a single `posthog` tool', () => {
    const tools = posthogTools(cfg('k', fakeFetch()));
    assert.deepEqual(Object.keys(tools), ['posthog']);
  });

  it('`tools` lists the session tools', async () => {
    const out = await exec(posthogTools(cfg('k', fakeFetch())), 'tools');
    assert.match(out, /execute-sql/);
    assert.match(out, /create-feature-flag/);
  });

  it('`search` filters by name and description', async () => {
    const out = await exec(
      posthogTools(cfg('k', fakeFetch())),
      'search flag',
    );
    assert.match(out, /feature-flag-get-all/);
    assert.doesNotMatch(out, /execute-sql/);
  });

  it('`info` returns the input schema', async () => {
    const out = await exec(
      posthogTools(cfg('k', fakeFetch())),
      'info execute-sql',
    );
    assert.match(out, /"query"/);
  });

  it('`schema` drills into a schema field', async () => {
    const out = await exec(
      posthogTools(cfg('k', fakeFetch())),
      'schema execute-sql query',
    );
    assert.match(out, /"type": "string"/);
  });

  it('`call` invokes the tool and returns parsed output', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const out = await exec(
      posthogTools(cfg('k', fakeFetch(calls))),
      'call execute-sql {"query":"SELECT 1"}',
    );
    assert.deepEqual(calls, [['execute-sql', { query: 'SELECT 1' }]]);
    assert.match(out, /42/);
  });

  it('denies destructive tools', async () => {
    const out = await exec(
      posthogTools(cfg('k', fakeFetch())),
      'call delete-feature-flag {"id":1}',
    );
    assert.match(out, /disabled/);
  });

  it('rejects unknown tools and bad JSON without throwing', async () => {
    const tools = posthogTools(cfg('k', fakeFetch()));
    assert.match(await exec(tools, 'call nope {}'), /unknown tool/);
    assert.match(await exec(tools, 'call execute-sql {bad'), /invalid JSON/);
    assert.match(await exec(tools, 'bogus'), /commands:/);
  });
});

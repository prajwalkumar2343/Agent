import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { startMockSimServer } from './mcp/server.ts';
import { CANNED_REPORTS } from './mcp/responses.ts';
import { createOutsetProvider, outsetSimConfigFromEnv } from './providers/outset.ts';
import { getSimProvider } from './index.ts';
import type { Spec } from '../../shared/src/index.ts';

const SPEC: Spec = { title: 'Dark mode', slug: 'dark-mode', summary: 's', acceptance: ['toggle', 'persist'] };

test('outset provider fails loudly without OUTSET_API_URL', () => {
  assert.throws(() => outsetSimConfigFromEnv({ SIM_PROVIDER: 'outset' }), /OUTSET_API_URL/);
});

test('SIM_PROVIDER=outset resolves via OUTSET_API_URL', async (t) => {
  const server = await startMockSimServer(0);
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const provider = getSimProvider({
    SIM_PROVIDER: 'outset',
    OUTSET_API_URL: `http://127.0.0.1:${port}/mcp`,
  });
  assert.equal(provider.name, 'outset');
  const report = await provider.simulate({ spec: SPEC });
  assert.ok(CANNED_REPORTS.some((r) => r.summary === report.summary));
});

test('outset provider rejects a malformed report', async () => {
  const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number | string };
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 202, headers: new Headers(), text: async () => '' };
    }
    const result =
      body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'outset', version: '0.0.0' } }
        : { structuredContent: { verdict: 'maybe', confidence: 2, summary: 'x', persona_reactions: [] } };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }),
    };
  }) as typeof fetch;

  const provider = createOutsetProvider({ url: 'http://127.0.0.1:1/mcp', fetchFn });
  await assert.rejects(() => provider.simulate({ spec: SPEC }), /outset sim: bad verdict/);
});

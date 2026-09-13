import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectEvidence,
  createPostHogMcp,
  ensureFeatureFlag,
  featureCheckEvents,
  findFlagByKey,
  flagMetrics,
  formatMetricLine,
  matchEvents,
  posthogMcpConfigFromEnv,
  setRolloutPercentage,
  specKeywords,
  sqlRows,
  type FeatureFlag,
} from '../src/index.ts';

interface SeenRequest {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  authorization?: string;
  projectPin?: string;
}

/**
 * Fetch double for the MCP server: answers initialize/tools/list/tools/call,
 * records every request, and can reply as SSE or plain JSON.
 */
function fakePostHog(opts: {
  tools?: { name: string; description?: string; inputSchema?: unknown }[];
  call?: (name: string, args: Record<string, unknown>) => unknown;
  sse?: boolean;
}) {
  const seen: SeenRequest[] = [];
  const respond = (payload: unknown, sessionId = 'sess-1'): Response => {
    const body = opts.sse
      ? `event: message\ndata: ${JSON.stringify(payload)}\n\n`
      : JSON.stringify(payload);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': opts.sse ? 'text/event-stream' : 'application/json',
        'mcp-session-id': sessionId,
      },
    });
  };
  const fetchFn = async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const msg = JSON.parse(init?.body ?? '{}') as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    seen.push({
      method: msg.method,
      params: msg.params,
      sessionId: init?.headers?.['mcp-session-id'],
      authorization: init?.headers?.authorization,
      projectPin: init?.headers?.['x-posthog-project-id'],
    });
    if (msg.method === 'initialize') {
      return respond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
    }
    if (msg.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    if (msg.method === 'tools/list') {
      return respond({ jsonrpc: '2.0', id: msg.id, result: { tools: opts.tools ?? [] } });
    }
    if (msg.method === 'tools/call') {
      const p = msg.params as { name: string; arguments: Record<string, unknown> };
      const out = opts.call?.(p.name, p.arguments);
      if (out instanceof Error) {
        return respond({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: out.message }], isError: true },
        });
      }
      return respond({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out ?? {}) }],
        },
      });
    }
    return new Response('nope', { status: 400 });
  };
  return { fetchFn: fetchFn as unknown as typeof fetch, seen };
}

const SPEC = {
  title: 'Saved payment methods at checkout',
  slug: 'saved-payment-methods',
  summary: 'Let users save a card and reuse it at checkout.',
  acceptance: ['user can save a card', 'user can pay with a saved card'],
};

const EVENTS_SQL = 'GROUP BY event';

describe('posthog mcp transport', () => {
  it('handshakes once, then calls tools with the session id', async () => {
    const { fetchFn, seen } = fakePostHog({
      tools: [{ name: 'execute-sql', inputSchema: { type: 'object' } }],
      call: () => ({ ok: 1 }),
    });
    const ph = createPostHogMcp({ apiKey: 'phx_test', projectId: '42', fetchFn });

    const tools = await ph.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['execute-sql']);
    const out = await ph.callTool('execute-sql', { query: 'SELECT 1' });

    assert.deepEqual(seen.map((r) => r.method), [
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    assert.equal(seen[0]!.sessionId, undefined);
    assert.equal(seen[2]!.sessionId, 'sess-1');
    assert.equal(seen[0]!.authorization, 'Bearer phx_test');
    assert.equal(seen[0]!.projectPin, '42');
    assert.deepEqual(out, { ok: 1 });
  });

  it('parses SSE responses', async () => {
    const { fetchFn } = fakePostHog({ sse: true, call: () => 'pong' });
    const ph = createPostHogMcp({ apiKey: 'k', fetchFn });
    assert.equal(await ph.callToolText('x'), 'pong');
  });

  it('throws on isError tool results', async () => {
    const { fetchFn } = fakePostHog({ call: () => new Error('boom') });
    const ph = createPostHogMcp({ apiKey: 'k', fetchFn });
    await assert.rejects(() => ph.callTool('execute-sql', {}), /boom/);
  });
});

describe('flags over MCP', () => {
  const flag: FeatureFlag = {
    id: 7,
    key: 'feat_saved_cards',
    active: false,
    filters: { groups: [{ properties: [{ key: 'plan' }], rollout_percentage: 10 }] },
  };

  it('findFlagByKey resolves via the by-key tool', async () => {
    const { fetchFn, seen } = fakePostHog({
      call: (name) => (name === 'feature-flag-get-definition-by-key' ? { results: [flag] } : {}),
    });
    const found = await findFlagByKey(createPostHogMcp({ apiKey: 'k', fetchFn }), 'feat_saved_cards');
    assert.equal(found?.id, 7);
    const tools = seen.filter((r) => r.method === 'tools/call').map((r) => r.params?.name);
    assert.deepEqual(tools, ['feature-flag-get-definition-by-key']);
  });

  it('findFlagByKey falls back to list search', async () => {
    const { fetchFn } = fakePostHog({
      call: (name) =>
        name === 'feature-flag-get-all' ? { results: [{ id: 7, key: 'feat_saved_cards' }] } : {},
    });
    const found = await findFlagByKey(createPostHogMcp({ apiKey: 'k', fetchFn }), 'feat_saved_cards');
    assert.equal(found?.id, 7);
  });

  it('setRolloutPercentage patches every group and activates', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const { fetchFn } = fakePostHog({
      call: (name, args) => {
        calls.push([name, args]);
        return {};
      },
    });
    await setRolloutPercentage(createPostHogMcp({ apiKey: 'k', fetchFn }), flag, 25);
    const [name, args] = calls.find(([n]) => n === 'update-feature-flag')!;
    assert.equal(name, 'update-feature-flag');
    assert.equal(args.id, 7);
    assert.equal(args.active, true);
    const groups = (args.filters as { groups: { rollout_percentage: number; properties: unknown[] }[] })
      .groups;
    assert.equal(groups[0]!.rollout_percentage, 25);
    assert.deepEqual(groups[0]!.properties, [{ key: 'plan' }]); // targeting preserved
  });

  it('setRolloutPercentage rejects bad pct', async () => {
    const { fetchFn } = fakePostHog({});
    await assert.rejects(
      () => setRolloutPercentage(createPostHogMcp({ apiKey: 'k', fetchFn }), flag, 101),
      /invalid rollout percentage/,
    );
  });

  it('ensureFeatureFlag creates at 0% when missing', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const { fetchFn } = fakePostHog({
      call: (name, args) => {
        calls.push([name, args]);
        return name === 'create-feature-flag' ? { id: 9, key: 'feat_x' } : {};
      },
    });
    const res = await ensureFeatureFlag(
      createPostHogMcp({ apiKey: 'k', fetchFn }),
      'feat_x',
      'X feature',
    );
    assert.equal(res.created, true);
    assert.equal(res.flag.id, 9);
    const [, args] = calls.find(([n]) => n === 'create-feature-flag')!;
    assert.equal(args.active, false);
    assert.equal(
      (args.filters as { groups: { rollout_percentage: number }[] }).groups[0]!.rollout_percentage,
      0,
    );
  });
});

describe('evidence over MCP', () => {
  it('specKeywords extracts meaningful tokens', () => {
    const kws = specKeywords(SPEC);
    assert.ok(kws.includes('saved'));
    assert.ok(kws.includes('checkout'));
    assert.ok(!kws.includes('the'));
  });

  it('matchEvents folds separators and case', () => {
    const counts = [
      { name: 'user_signed_up', count: 10 },
      { name: 'checkout completed', count: 5 },
      { name: '$pageview', count: 99 },
    ];
    assert.deepEqual(
      matchEvents(counts, ['checkout', 'signed']).map((e) => e.name),
      ['user_signed_up', 'checkout completed'],
    );
  });

  it('featureCheckEvents reports searched=false on PostHog failure', async () => {
    const { fetchFn } = fakePostHog({ call: () => new Error('down') });
    const res = await featureCheckEvents(createPostHogMcp({ apiKey: 'k', fetchFn }), SPEC);
    assert.deepEqual(res, { searched: false, matched: [] });
  });

  it('collectEvidence returns related events and sessions', async () => {
    const { fetchFn, seen } = fakePostHog({
      call: (_name, args) => {
        const q = String(args.query ?? '');
        if (q.includes('$session_id')) return { results: [['sess-abc', 12], ['sess-def', 4]] };
        if (q.includes(EVENTS_SQL)) {
          return {
            results: [
              ['checkout_completed', 320],
              ['card_saved', 88],
              ['$pageview', 9000],
            ],
          };
        }
        return { results: [] };
      },
    });
    const ev = await collectEvidence(createPostHogMcp({ apiKey: 'k', fetchFn }), SPEC);
    assert.ok(ev.related_events.some((e) => e.name === 'card_saved' && e.count_30d === 88));
    assert.deepEqual(ev.notable_sessions, ['sess-abc', 'sess-def']);
    assert.equal(ev.recordings_reviewed, 2);
    assert.match(ev.summary, /relate to/);
    assert.ok(
      seen.some(
        (r) => r.method === 'tools/call' && String(r.params?.name) === 'execute-sql',
      ),
    );
  });
});

describe('metrics over MCP', () => {
  it('flagMetrics aggregates exposures, variants, exceptions', async () => {
    const { fetchFn } = fakePostHog({
      call: (_name, args) => {
        const q = String(args.query ?? '');
        if (q.includes('$feature_flag_response')) return { results: [['true', 30], ['false', 6]] };
        if (q.includes('$exception')) return { results: [[2]] };
        if (q.includes('INTERVAL 48 HOUR')) return { results: [[20]] };
        return { results: [[36, 21]] };
      },
    });
    const m = await flagMetrics(createPostHogMcp({ apiKey: 'k', fetchFn }), 'feat_x', 24);
    assert.equal(m.exposures, 36);
    assert.equal(m.unique_users, 21);
    assert.deepEqual(m.variants, { true: 30, false: 6 });
    assert.equal(m.prev_exposures, 20);
    assert.equal(m.exceptions, 2);
  });

  it('formatMetricLine renders the sweep line', () => {
    const line = formatMetricLine('feat_x', 15, {
      flag_key: 'feat_x',
      window_hours: 24,
      exposures: 36,
      unique_users: 21,
      variants: { true: 30 },
      prev_exposures: 20,
      exceptions: 0,
    });
    assert.match(line, /`feat_x` at \*15%\*/);
    assert.match(line, /36 exposures \/ 21 users/);
    assert.match(line, /\+80%/);
  });
});

describe('env config', () => {
  it('requires POSTHOG_API_KEY and defaults the URL', () => {
    assert.throws(() => posthogMcpConfigFromEnv({}), /POSTHOG_API_KEY/);
    const cfg = posthogMcpConfigFromEnv({ POSTHOG_API_KEY: 'phx', POSTHOG_PROJECT_ID: '1' });
    assert.equal(cfg.apiKey, 'phx');
    assert.equal(cfg.projectId, '1');
    assert.equal(cfg.url, undefined);
  });
});

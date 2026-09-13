import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Test plumbing for api/ handler tests — fake Vercel req/res, Slack request
 * signing, and a global fetch stub that plays Slack Web API, GitHub REST,
 * the internal /api/rollout/parse forward, and Slack response_urls.
 * `api/_test/` is underscore-prefixed like `_lib/` so Vercel never routes it.
 */

export const TEST_SIGNING_SECRET = 'test-signing-secret';

export function slackSignature(raw: string, ts = String(Math.floor(Date.now() / 1000))): {
  timestamp: string;
  signature: string;
} {
  return {
    timestamp: ts,
    signature:
      'v0=' +
      crypto.createHmac('sha256', TEST_SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest('hex'),
  };
}

/** Minimal VercelRequest — the handlers only need method, headers, and async iteration. */
export function fakeReq(raw: string, headers: Record<string, string>): VercelRequest {
  async function* body() {
    yield Buffer.from(raw);
  }
  return Object.assign(body(), { method: 'POST', headers }) as unknown as VercelRequest;
}

export interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  send(b: unknown): FakeRes;
  json(b: unknown): FakeRes;
}

export function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    send(b) {
      res.body = b;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
  };
  return res;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FetchStub {
  calls: RecordedCall[];
  /** Calls whose URL contains the needle. */
  to(needle: string): RecordedCall[];
  /** Parsed JSON bodies of calls whose URL contains the needle. */
  jsonTo(needle: string): unknown[];
  restore(): void;
}

function defaultResponse(url: string): Response {
  if (url.includes('slack.com/api/conversations.open')) {
    return Response.json({ ok: true, channel: { id: 'D-dm' } });
  }
  if (url.includes('slack.com/api/')) {
    return Response.json({ ok: true, ts: '9999.0001' });
  }
  if (url.includes('api.github.com')) {
    return new Response(null, { status: 204 });
  }
  return new Response('ok', { status: 200 });
}

/**
 * Install a fetch stub. `onCall` may return a Response to override the
 * default routing (Slack ok / GitHub 204 / 200 for everything else).
 */
export function installFetchStub(
  onCall?: (call: RecordedCall) => Response | undefined,
): FetchStub {
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    return onCall?.(call) ?? defaultResponse(call.url);
  }) as typeof fetch;
  return {
    calls,
    to: (needle) => calls.filter((c) => c.url.includes(needle)),
    jsonTo: (needle) =>
      calls
        .filter((c) => c.url.includes(needle))
        .map((c) => (c.body ? JSON.parse(c.body) : null)),
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Baseline env for handler tests — overrides applied per test then restored. */
export function setBaseEnv(): void {
  Object.assign(process.env, {
    SLACK_SIGNING_SECRET: TEST_SIGNING_SECRET,
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_TEAM_ID: 'T-test',
    PM_USER_IDS: 'U-pm',
    RUN_CALLBACK_SECRET: 'run-secret',
    APP_URL: 'app.test',
    SPEC_PROVIDER: 'mock',
    GH_AGENT_PAT: 'ghp-test',
    PLATFORM_REPO: 'org/platform',
    PRODUCT_REPO: 'org/product',
  });
  for (const k of [
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'POSTHOG_API_KEY',
    'DOCS_MCP_URL',
    'INTAKE_USER_IDS',
    'INTAKE_CHANNEL_IDS',
    'AGENT_PAUSED',
    'VERCEL_URL',
  ]) {
    delete process.env[k];
  }
}

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('waitFor timed out');
}

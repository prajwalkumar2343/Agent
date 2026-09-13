/**
 * PostHog REST adapter — the only place API auth/host are wired. Workstream
 * modules (evidence.ts, flags.ts, metrics.ts) call `client.api()` instead of
 * re-implementing fetch/auth.
 */

export interface PostHogConfig {
  apiKey: string;
  projectId: string;
  host: string;
  fetchFn?: typeof fetch;
}

export function posthogConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PostHogConfig {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };
  return {
    apiKey: need('POSTHOG_API_KEY'),
    projectId: need('POSTHOG_PROJECT_ID'),
    host: env.POSTHOG_HOST ?? 'https://app.posthog.com',
  };
}

export interface PostHogClient {
  /** Requests against /api/projects/:projectId/<path>. */
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

export function createPostHogClient(config: PostHogConfig): PostHogClient {
  const host = config.host.replace(/\/+$/, '');
  const call = config.fetchFn ?? fetch;
  return {
    async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
      const res = await call(
        `${host}/api/projects/${encodeURIComponent(config.projectId)}/${path.replace(/^\/+/, '')}`,
        {
          method: init.method ?? 'GET',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        },
      );
      if (!res.ok) throw new Error(`posthog ${init.method ?? 'GET'} ${path} failed: ${res.status}`);
      return (await res.json()) as T;
    },
  };
}

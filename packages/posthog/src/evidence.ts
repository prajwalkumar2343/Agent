import type { Evidence, FeatureCheck, Spec } from '../../shared/src/index.ts';
import type { PostHogMcp } from './mcp.ts';

/**
 * Evidence + taxonomy over the PostHog MCP `execute-sql` tool (HogQL on the
 * project's events table). Two consumers:
 *  - featureCheckEvents — the PostHog half of the `checked` two-signal check
 *  - collectEvidence    — the `evidence` state's related-events + sessions pull
 */

/** execute-sql returns {columns, results: [[...]]} — be tolerant about row shape. */
export function sqlRows(payload: unknown): unknown[][] {
  if (Array.isArray(payload)) return payload.filter(Array.isArray);
  if (!payload || typeof payload !== 'object') return [];
  const o = payload as Record<string, unknown>;
  const rows = o.results ?? o.data ?? o.rows;
  if (!Array.isArray(rows)) return [];
  const cols = Array.isArray(o.columns) ? (o.columns as string[]) : undefined;
  return rows.map((r) =>
    Array.isArray(r)
      ? r
      : cols
        ? cols.map((c) => (r as Record<string, unknown>)[c])
        : Object.values(r as Record<string, unknown>),
  );
}

async function runSql(client: PostHogMcp, query: string): Promise<unknown[][]> {
  return sqlRows(await client.callTool('execute-sql', { query }));
}

const STOP_WORDS = new Set(
  ('a an the and or for to of in on with that this from when user users feature button page into ' +
    'their they them have has should would could will make add new can able want need show allow ' +
    'lets let see use using used each every via per our your his her its are was were been being').split(' '),
);

/** Keyword seeds for matching event names — spec text or a bare word list. */
export function specKeywords(input: Spec | string[] | string): string[] {
  const text = Array.isArray(input)
    ? input.join(' ')
    : typeof input === 'string'
      ? input
      : [input.title, input.summary, ...(input.acceptance ?? [])].join(' ');
  const seen = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOP_WORDS.has(w)) seen.add(w);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

/** Fold snake_case/kebab/$ prefixes away so "signed up" matches `user_signed_up`. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface EventCount {
  name: string;
  count: number;
}

/** Top event names by volume over the window — the project's working taxonomy. */
export async function listEventCounts(
  client: PostHogMcp,
  days = 30,
  limit = 500,
): Promise<EventCount[]> {
  const rows = await runSql(
    client,
    `SELECT event, count() AS c FROM events WHERE timestamp > now() - INTERVAL ${Math.ceil(
      days,
    )} DAY GROUP BY event ORDER BY c DESC LIMIT ${Math.ceil(limit)}`,
  );
  return rows
    .map((r) => ({ name: String(r[0] ?? ''), count: Number(r[1]) || 0 }))
    .filter((e) => e.name);
}

export function matchEvents(counts: EventCount[], keywords: string[]): EventCount[] {
  const keys = keywords.map(squash).filter(Boolean);
  return counts.filter((e) => {
    const name = squash(e.name);
    return keys.some((k) => name.includes(k) || k.includes(name));
  });
}

/**
 * The events half of FeatureCheck — did the taxonomy search run, and which
 * event names look like the proposed feature? searched=false means PostHog was
 * unreachable, not "zero matches".
 */
export async function featureCheckEvents(
  client: PostHogMcp,
  spec: Spec | string[] | string,
): Promise<FeatureCheck['events']> {
  try {
    const matched = matchEvents(await listEventCounts(client, 90), specKeywords(spec)).map(
      (e) => e.name,
    );
    return { searched: true, matched };
  } catch {
    return { searched: false, matched: [] };
  }
}

const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Evidence for the build step: which existing events orbit this feature, how
 * often they fire, and which sessions to replay. Deterministic — no LLM in the
 * loop; the coding agent gets this as EVIDENCE_JSON.
 */
export async function collectEvidence(
  client: PostHogMcp,
  spec: Spec,
  days = 30,
): Promise<Evidence> {
  const counts = await listEventCounts(client, days);
  const matched = matchEvents(counts, specKeywords(spec));
  const related = (matched.length ? matched : counts.slice(0, 5))
    .slice(0, 10)
    .map((e) => ({ name: e.name, count_30d: e.count }));

  let sessions: string[] = [];
  if (matched.length) {
    const list = matched
      .slice(0, 5)
      .map((e) => sqlString(e.name))
      .join(', ');
    try {
      const rows = await runSql(
        client,
        `SELECT $session_id AS s, count() AS c FROM events WHERE event IN (${list}) ` +
          `AND $session_id != '' AND timestamp > now() - INTERVAL ${Math.ceil(days)} DAY ` +
          'GROUP BY s ORDER BY c DESC LIMIT 5',
      );
      sessions = rows.map((r) => String(r[0] ?? '')).filter(Boolean);
    } catch {
      sessions = [];
    }
  }

  const summary = matched.length
    ? `${matched.length} event(s) in the last ${days}d relate to "${spec.title}": ` +
      related.map((r) => `${r.name} ×${r.count_30d}`).join(', ') +
      (sessions.length ? `. ${sessions.length} session(s) to replay.` : '.')
    : `No existing events match "${spec.title}". Top events for reference: ` +
      related.map((r) => `${r.name} ×${r.count_30d}`).join(', ') +
      '.';

  return {
    summary,
    related_events: related,
    recordings_reviewed: sessions.length,
    notable_sessions: sessions,
  };
}

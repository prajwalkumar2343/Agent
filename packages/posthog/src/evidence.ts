import type { Evidence, FeatureCheck, Spec } from '../../shared/src/index.ts';
import type { PostHogMcp } from './mcp.ts';

/**
 * Evidence + taxonomy over the PostHog MCP `execute-sql` tool (HogQL on the
 * project's events table). Two consumers:
 *  - featureCheckEvents — the PostHog half of the `checked` two-signal check
 *  - collectEvidence    — the `evidence` state's related-events + sessions pull
 */

/**
 * execute-sql answers in two shapes: {columns, results: [[...]]} JSON (or a
 * bare row array) and — the hosted MCP server's actual text format — pipe-
 * delimited lines: a header row, then one `a|b|c` line per row.
 */
export function sqlRows(payload: unknown): unknown[][] {
  if (typeof payload === 'string') {
    const lines = payload.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length < 2) return [];
    return lines.slice(1).map((l) => l.split('|'));
  }
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
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
  for (const w of words) {
    if (w.length >= 4) seen.add(w);
    if (seen.size >= 12) break;
  }
  // Adjacent non-stop-word pairs/triples ride alongside the singles so a
  // multi-word name ("signed up") reaches matchEvents as one phrase keyword —
  // every token must be present in the event name for it to match.
  for (const n of [2, 3]) {
    for (let i = 0; i + n <= words.length && seen.size < 24; i++) {
      seen.add(words.slice(i, i + n).join(' '));
    }
  }
  return [...seen];
}

/** Split into lowercase alphanumeric tokens — `user_signed_up` → {user, signed, up}. */
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

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

/**
 * Whole-token matching only — keyword "card" must equal an event token, so it
 * no longer matches `discard`. A multi-word keyword matches when every one of
 * its tokens appears in the event name ("signed up" → user_signed_up).
 */
export function matchEvents(counts: EventCount[], keywords: string[]): EventCount[] {
  const keys = keywords.map(tokens).filter((t) => t.length > 0);
  return counts.filter((e) => {
    const words = new Set(tokens(e.name));
    return keys.some((k) => k.every((w) => words.has(w)));
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
 * loop; the coding agent gets this as EVIDENCE_JSON. The window is fixed at
 * 30 days — the shared Evidence type names the field `count_30d`.
 */
export async function collectEvidence(
  client: PostHogMcp,
  spec: Spec,
): Promise<Evidence> {
  const days = 30;
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

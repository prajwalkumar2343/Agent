import { sqlRows } from './evidence.ts';
import type { PostHogMcp } from './mcp.ts';

/**
 * Rollout metrics for api/cron/sweep (A10) — all HogQL over the MCP
 * execute-sql tool. PostHog SDKs emit `$feature_flag_called` with
 * `$feature_flag` / `$feature_flag_response` properties, which is the
 * exposure signal here.
 */

export interface FlagMetrics {
  flag_key: string;
  window_hours: number;
  /** $feature_flag_called events in the window. */
  exposures: number;
  /** distinct_ids that evaluated the flag. */
  unique_users: number;
  /** evaluated value → count ("true", variant keys, "false"). */
  variants: Record<string, number>;
  /** Exposures in the window before this one — for the trend arrow. */
  prev_exposures: number;
  /** Project-wide $exception count in the window — the cheap guardrail. */
  exceptions: number;
}

const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const num = (rows: unknown[][], i = 0): number => Number(rows[0]?.[i]) || 0;

export async function flagMetrics(
  client: PostHogMcp,
  flagKey: string,
  windowHours = 24,
): Promise<FlagMetrics> {
  const h = Math.ceil(windowHours);
  const key = sqlString(flagKey);
  const flagFilter =
    `event = '$feature_flag_called' ` +
    `AND JSONExtractString(properties, '$feature_flag') = ${key}`;

  const sql = (q: string) => client.callTool('execute-sql', { query: q }).then(sqlRows);

  const [exposureRows, prevRows, variantRows, exceptionRows] = await Promise.all([
    sql(
      `SELECT count(), count(DISTINCT distinct_id) FROM events WHERE ${flagFilter} ` +
        `AND timestamp > now() - INTERVAL ${h} HOUR`,
    ),
    sql(
      `SELECT count() FROM events WHERE ${flagFilter} ` +
        `AND timestamp > now() - INTERVAL ${2 * h} HOUR AND timestamp <= now() - INTERVAL ${h} HOUR`,
    ),
    sql(
      `SELECT JSONExtractString(properties, '$feature_flag_response') AS v, count() ` +
        `FROM events WHERE ${flagFilter} AND timestamp > now() - INTERVAL ${h} HOUR GROUP BY v`,
    ),
    sql(
      `SELECT count() FROM events WHERE event = '$exception' ` +
        `AND timestamp > now() - INTERVAL ${h} HOUR`,
    ),
  ]);

  const variants: Record<string, number> = {};
  for (const r of variantRows) {
    const v = String(r[0] ?? '');
    if (v) variants[v] = Number(r[1]) || 0;
  }

  return {
    flag_key: flagKey,
    window_hours: h,
    exposures: num(exposureRows, 0),
    unique_users: num(exposureRows, 1),
    variants,
    prev_exposures: num(prevRows),
    exceptions: num(exceptionRows),
  };
}

/** One Slack-ready line — what sweep's report #N posts into the run thread. */
export function formatMetricLine(
  flagKey: string,
  rolloutPct: number | undefined,
  m: FlagMetrics,
): string {
  const delta =
    m.prev_exposures > 0
      ? `${m.exposures >= m.prev_exposures ? '+' : ''}${Math.round(
          ((m.exposures - m.prev_exposures) / m.prev_exposures) * 100,
        )}% vs prior ${m.window_hours}h`
      : 'no prior-window baseline';
  const variants =
    Object.entries(m.variants)
      .map(([v, n]) => `\`${v}\` ×${n}`)
      .join(', ') || 'none';
  return (
    `Flag \`${flagKey}\` at *${rolloutPct ?? 0}%* — ` +
    `${m.exposures} exposures / ${m.unique_users} users in ${m.window_hours}h (${delta}). ` +
    `Values: ${variants}. Exceptions project-wide: ${m.exceptions}.`
  );
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The product's shipped-feature index. `features.md` at the repo root is a
 * checked-in copy of the product's own feature list — one
 * `- **Name** — description` bullet per shipped feature. The `checked` state
 * matches spec keywords against it; a hit means the idea already exists, so
 * the pipeline tells the requester and stops instead of building a duplicate.
 */

export interface FeatureIndexEntry {
  name: string;
  /** Squashed `name + description` — the haystack keyword matching runs on. */
  squashed: string;
}

let cached: FeatureIndexEntry[] | null | undefined;

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function parse(markdown: string): FeatureIndexEntry[] {
  const out: FeatureIndexEntry[] = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^\s*-\s+\*\*(.+?)\*\*\s*[—–-]?\s*(.*)$/);
    if (m) out.push({ name: m[1]!.trim(), squashed: squash(`${m[1]} ${m[2]}`) });
  }
  return out;
}

/**
 * Parsed index entries, or null when the file isn't readable — callers treat
 * null like any other unreachable check source (`searched: false`), not a
 * run failure. Resolved once per process.
 */
export function featureIndexEntries(): FeatureIndexEntry[] | null {
  if (cached !== undefined) return cached;
  const candidates = [
    new URL('../../../features.md', import.meta.url),
    join(process.cwd(), 'features.md'),
  ];
  for (const candidate of candidates) {
    try {
      cached = parse(readFileSync(candidate, 'utf8'));
      return cached;
    } catch {
      // try the next candidate
    }
  }
  return (cached = null);
}

/** Names of shipped features whose entry text contains any spec keyword. */
export function matchFeatureIndex(
  entries: FeatureIndexEntry[],
  squashedKeywords: string[],
): string[] {
  return entries
    .filter((e) => squashedKeywords.some((k) => e.squashed.includes(k)))
    .map((e) => e.name);
}

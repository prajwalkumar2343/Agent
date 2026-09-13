import { createHash } from 'node:crypto';
import { kvCommand, kvConfigured } from './kv.ts';
import { intakePolicy, pipelinePaused, type IntakePolicy } from './policy.ts';
import { screenFeatureIdea, INVISIBLE_CHARS } from './scan.ts';

/**
 * Intake gate — runs before a Slack idea is acknowledged, let alone before
 * a build is dispatched. Order matters: cheap hard checks first (paused,
 * allowlist, screening, arg validation), then dedup — ahead of the capacity
 * check so a repeat is still caught when the pipeline is full — and the
 * daily counters last so a rejected call doesn't consume a rate-limit slot.
 */

export interface IntakeDecision {
  allow: boolean;
  /** Human-facing reason when allow=false. */
  reason?: string;
  /** Screening flags on allowed-but-suspicious requests — audit these. */
  flags?: string[];
  policy: IntakePolicy;
}

/* In-memory fallback counters — dev only; KV is the real backend. */
const memCounters = new Map<string, { count: number; resetAt: number }>();
const memDedup = new Map<string, number>();

function memIncr(key: string, ttlMs: number): number {
  const now = Date.now();
  const e = memCounters.get(key);
  if (!e || e.resetAt <= now) {
    memCounters.set(key, { count: 1, resetAt: now + ttlMs });
    return 1;
  }
  e.count += 1;
  return e.count;
}

const DAY_MS = 86_400_000;

/** INCR with a 2-day TTL. Returns the new count. */
async function incr(key: string, env: NodeJS.ProcessEnv): Promise<number> {
  if (kvConfigured(env)) {
    const n = await kvCommand<number>(['incr', key], env);
    if (n === 1) await kvCommand(['expire', key, String(Math.ceil((2 * DAY_MS) / 1000))], env);
    return n ?? 1;
  }
  return memIncr(key, 2 * DAY_MS);
}

/** SET NX EX — true when the marker was fresh (not a duplicate). */
async function markFresh(key: string, ttlMinutes: number, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (kvConfigured(env)) {
    const res = await kvCommand<string>(
      ['set', key, '1', 'NX', 'EX', String(ttlMinutes * 60)],
      env,
    );
    return res === 'OK';
  }
  const now = Date.now();
  const seen = memDedup.get(key);
  if (seen && seen > now) return false;
  memDedup.set(key, now + ttlMinutes * 60_000);
  return true;
}

function dayStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // UTC day bucket
}

function dedupKey(user: string, idea: string): string {
  // Invisibles and case/whitespace differences shouldn't defeat dedup.
  const norm = idea.replace(INVISIBLE_CHARS, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const h = createHash('sha256').update(`${user}:${norm}`).digest('hex').slice(0, 24);
  return `guard:dedup:${h}`;
}

export interface IntakeInput {
  user: string;
  channel: string;
  idea: string;
  /** Non-terminal runs currently in flight — caller computes from the store. */
  activeRuns: number;
  env?: NodeJS.ProcessEnv;
}

export async function checkIntake(input: IntakeInput): Promise<IntakeDecision> {
  const env = input.env ?? process.env;
  const policy = intakePolicy(env);
  const now = Date.now();
  const deny = (reason: string): IntakeDecision => ({ allow: false, reason, policy });

  if (pipelinePaused(env)) return deny('pipeline is paused (AGENT_PAUSED)');
  if (policy.users.length && !policy.users.includes(input.user)) {
    return deny('requester is not on the intake allowlist');
  }
  if (policy.channels.length && !policy.channels.includes(input.channel)) {
    return deny('channel is not on the intake allowlist');
  }

  const screen = screenFeatureIdea(input.idea, policy.maxIdeaChars);
  if (screen.verdict === 'block') {
    return deny(`request rejected by screening (${screen.reasons.join(', ')})`);
  }

  const day = dayStamp(now);
  // Caller-supplied — validate rather than trust: NaN or a negative count
  // would slip past the concurrency cap below (NaN >= n is false).
  if (!Number.isInteger(input.activeRuns) || input.activeRuns < 0) {
    return deny('invalid active-run count');
  }

  // Dedup runs before the capacity check so a repeat is still reported as
  // a duplicate when the pipeline is full.
  if (!(await markFresh(dedupKey(input.user, input.idea), policy.dedupMinutes, env))) {
    return deny('duplicate request already in flight');
  }
  if (input.activeRuns >= policy.maxActive) {
    return deny(`too many runs in flight (${input.activeRuns}/${policy.maxActive})`);
  }

  if ((await incr(`guard:rate:user:${input.user}:${day}`, env)) > policy.perUserPerDay) {
    return deny(`daily limit reached (${policy.perUserPerDay}/day)`);
  }
  if ((await incr(`guard:rate:all:${day}`, env)) > policy.perDay) {
    return deny(`pipeline daily limit reached (${policy.perDay}/day)`);
  }

  return {
    allow: true,
    ...(screen.verdict === 'flag' ? { flags: screen.reasons } : {}),
    policy,
  };
}

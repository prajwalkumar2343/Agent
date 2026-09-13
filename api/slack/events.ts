import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import {
  pmUserIds,
  requireEnv,
  slugify,
  RUN_COMPLETE_SECRET_HEADER,
  type Evidence,
  type FeatureCheck,
  type Run,
  type Spec,
} from '../../packages/shared/src/index.ts';
import {
  evidenceBlocks,
  featureCheckBlocks,
  postMessage,
  specBlocks,
  verifySlackSignature,
} from '../../packages/slack-kit/src/index.ts';
import {
  createRunStoreFromEnv,
  isTerminal,
  newRun,
  RunExistsError,
  transitionRun,
} from '../../packages/store/src/index.ts';
import { audit, checkIntake } from '../../packages/guard/src/index.ts';
import {
  featureIndexEntries,
  flagKeyForSpec,
  generateSpec,
  matchFeatureIndex,
} from '../../packages/spec/src/index.ts';
import { modelFromEnv } from '../../packages/runner/src/model.ts';
import { docsClientFromEnv } from '../../packages/mintlify/src/index.ts';
import {
  collectEvidence,
  createPostHogMcp,
  ensureFeatureFlag,
  featureCheckEvents,
  posthogMcpConfigFromEnv,
  specKeywords,
} from '../../packages/posthog/src/index.ts';
import { dispatchFeatureRun } from '../_lib/github.ts';
import { dmUser } from '../_lib/notify.ts';
import { header, readRawBody } from '../_lib/http.ts';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

const seenEventIds = new Set<string>();

interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
}

const appHost = (): string | undefined => process.env.APP_URL ?? process.env.VERCEL_URL;

/** A2 → A9/A10 wiring: thread replies + PM DMs ride to the control plane. */
async function forwardToParse(input: {
  thread_ts: string;
  channel: string;
  user: string;
  text: string;
}): Promise<void> {
  const host = appHost();
  if (!host) {
    console.warn('slack/events: APP_URL/VERCEL_URL unset — cannot reach api/rollout/parse');
    return;
  }
  const res = await fetch(`https://${host}/api/rollout/parse`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RUN_COMPLETE_SECRET_HEADER]: requireEnv('RUN_CALLBACK_SECRET'),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) console.error(`rollout/parse forward failed: ${res.status}`);
}

/**
 * Idea → Spec. `SPEC_PROVIDER=mock` skips the LLM for local dev/tests —
 * same env-keyed provider pattern as SIM_PROVIDER. The LLM path uses the
 * trusted-zone provider env (LLM_PROVIDER/LLM_MODEL + provider key).
 */
export async function specFor(idea: string): Promise<Spec> {
  if ((process.env.SPEC_PROVIDER ?? 'llm') === 'mock') {
    const title = idea.split(/\s+/).slice(0, 6).join(' ') || 'untitled feature';
    return {
      title,
      slug: slugify(title) || 'untitled-feature',
      summary: idea.slice(0, 500) || title,
      acceptance: [`user can ${idea.toLowerCase().slice(0, 80)}`],
    };
  }
  return generateSpec(idea, modelFromEnv());
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The `checked` state's three-signal check: the shipped-feature index
 * (features.md), Mintlify docs search, and the PostHog event taxonomy. A
 * docs hit counts only when a spec keyword actually appears in the page
 * title/url — a bare top-k result is not evidence. Unreachable sources mark
 * `searched:false` rather than failing the run.
 */
export async function runFeatureCheck(spec: Spec): Promise<FeatureCheck> {
  const keys = specKeywords(spec).map(squash);

  const entries = featureIndexEntries();
  const index: NonNullable<FeatureCheck['index']> = {
    searched: entries !== null,
    hits: entries ? matchFeatureIndex(entries, keys) : [],
  };

  const docs: FeatureCheck['docs'] = { searched: false, pages: [], hits: [] };
  if (process.env.DOCS_MCP_URL) {
    try {
      const hits = await docsClientFromEnv().search(`${spec.title} ${spec.summary}`, 5);
      docs.searched = true;
      docs.pages = hits.map((h) => h.url).filter(Boolean);
      docs.hits = hits
        .filter((h) => keys.some((k) => squash(`${h.title} ${h.url}`).includes(k)))
        .map((h) => h.title);
    } catch (err) {
      console.error('docs search failed', err);
    }
  }

  const events: FeatureCheck['events'] = { searched: false, matched: [] };
  if (process.env.POSTHOG_API_KEY) {
    const ph = createPostHogMcp(posthogMcpConfigFromEnv());
    const r = await featureCheckEvents(ph, spec);
    events.searched = r.searched;
    events.matched = r.matched;
  }

  const indexHit = index.hits.length > 0;
  const docHit = docs.hits.length > 0;
  const eventHit = events.matched.length > 0;
  const exists = indexHit || docHit || eventHit;
  const signals = [indexHit, docHit, eventHit].filter(Boolean).length;
  const searched = index.searched || docs.searched || events.searched;
  const confidence = exists ? (signals >= 2 ? 0.9 : 0.65) : searched ? 0.2 : 0;
  const reason = exists
    ? indexHit
      ? `Feature index already lists "${spec.title}": ${index.hits.slice(0, 3).join(', ')}.`
      : `${signals} signal(s) suggest "${spec.title}" already ships.`
    : searched
      ? `No check source mentions "${spec.title}".`
      : 'All check sources were unreachable — proceeding without a check.';
  return { exists, confidence, reason, docs, events, index };
}

function failText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The intake → build pipeline for one Slack idea. Runs inside waitUntil
 * after the 200 ack; every transition goes through the state machine and
 * each milestone posts back into the run thread.
 */
export async function handleIdea(event: SlackEvent): Promise<void> {
  if (!event.channel) return;
  const threadTs = event.thread_ts ?? event.ts;
  const idea = (event.text ?? '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '').trim();
  // A bare mention/empty DM has no idea to run on — ask for one instead of
  // creating a run that will pipeline a blank spec (empty summary →
  // invalid_blocks on the spec card).
  if (!idea) {
    await postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: "What's the feature idea? One sentence is plenty.",
    });
    return;
  }
  const store = createRunStoreFromEnv();

  // Safeguard gate: kill switch → allowlists → injection screening →
  // rate limits → dedup. A rejection still gets a polite reply so the
  // requester isn't left hanging; every decision hits the audit trail.
  const runs = await store.list();
  const activeRuns = runs.filter((r) => !isTerminal(r.state)).length;
  const decision = await checkIntake({
    user: event.user ?? '',
    channel: event.channel,
    idea,
    activeRuns,
  });
  await audit('intake', {
    user: event.user,
    channel: event.channel,
    allow: decision.allow,
    reason: decision.reason,
    flags: decision.flags,
  });
  // Requester-facing replies are deliberately minimal — the run lifecycle
  // (spec, feature check, evidence, build, report) goes to the PM's DM so a
  // feature-request thread doesn't fill with pipeline chatter. With no PM
  // configured, pmSay falls back to the thread rather than dropping cards.
  const pmId = pmUserIds()[0] ?? '';
  const threadSay = (text: string, blocks?: unknown[]) =>
    postMessage({ channel: event.channel!, thread_ts: threadTs, text, blocks });
  const pmSay = (text: string, blocks?: unknown[]) =>
    pmId ? dmUser(pmId, text, blocks) : threadSay(text, blocks);
  const runRef = `requested by <@${event.user}> in <#${event.channel}>`;

  if (!decision.allow) {
    await threadSay(`Can't take that one — ${decision.reason}.`);
    return;
  }
  if (decision.flags?.length) {
    await pmSay(
      `Heads-up: a request was flagged for review (${decision.flags.join(', ')}) — ${runRef}. ` +
        'Proceeding, but a human may audit it.',
    );
  }

  try {
    await store.create(
      newRun({
        thread_ts: threadTs,
        channel: event.channel,
        requester_id: event.user ?? '',
        pm_id: pmId,
        idea,
      }),
    );
  } catch (err) {
    if (err instanceof RunExistsError) {
      await threadSay('This thread already has a run — start a new thread (or DM me) for a new idea.');
      return;
    }
    throw err;
  }

  await threadSay('Thanks for the feature request — on it. I’ll post back here when the PR lands.');

  try {
    const spec = await specFor(idea);
    const flagKey = flagKeyForSpec(spec);
    await transitionRun(store, threadTs, 'spec', { spec, flag_key: flagKey });
    await pmSay(`Spec drafted — *${spec.title}* (${runRef})`, specBlocks(spec, flagKey));

    const check = await runFeatureCheck(spec);
    await transitionRun(store, threadTs, 'checked', { feature_check: check });
    const indexHits = check.index?.hits ?? [];
    await pmSay(
      indexHits.length
        ? 'Feature check: this already exists — closing the run.'
        : check.exists
          ? 'Feature check: this may already exist — see below.'
          : 'Feature check: looks new.',
      featureCheckBlocks(check),
    );

    // A shipped-feature index hit is authoritative — the product already has
    // this, so tell the requester it exists and close the run: no evidence,
    // no flag, no build.
    if (indexHits.length) {
      await threadSay(
        `That feature already exists — "${spec.title}" is covered by ` +
          `${indexHits.slice(0, 3).join(', ')}. Nothing to build.`,
      );
      await transitionRun(store, threadTs, 'done');
      return;
    }

    // exists=false skips `evidence` straight to `build` (docs/CONTRACTS.md).
    let evidence: Evidence | undefined;
    if (check.exists && process.env.POSTHOG_API_KEY) {
      try {
        evidence = await collectEvidence(
          createPostHogMcp(posthogMcpConfigFromEnv()),
          spec,
        );
        await transitionRun(store, threadTs, 'evidence', { evidence });
        await pmSay('Evidence collected.', evidenceBlocks(evidence));
      } catch (err) {
        console.error(`evidence failed for ${threadTs}`, err);
      }
    }

    // The flag must exist before the merge gate can set a rollout — the
    // coding agent also ensures it, so a PostHog outage here is not fatal.
    let flagId: number | undefined;
    if (process.env.POSTHOG_API_KEY) {
      try {
        const { flag } = await ensureFeatureFlag(
          createPostHogMcp(posthogMcpConfigFromEnv()),
          flagKey,
          spec.title,
        );
        flagId = flag.id;
      } catch (err) {
        console.error(`ensureFeatureFlag failed for ${threadTs}`, err);
      }
    }

    await transitionRun(store, threadTs, 'build', {
      flag_key: flagKey,
      ...(flagId !== undefined ? { flag_id: flagId } : {}),
    });
    const host = appHost();
    if (!host) throw new Error('APP_URL/VERCEL_URL unset — cannot build callback URL');
    await dispatchFeatureRun({
      thread_ts: threadTs,
      spec_json: JSON.stringify(spec),
      feature_context_json: JSON.stringify({
        check,
        channel: event.channel,
        requester_id: event.user ?? '',
      }),
      evidence_json: JSON.stringify(evidence ?? null),
      flag_key: flagKey,
      callback_url: `https://${host}/api/runs/complete`,
    });
    await pmSay(`Building — the coding agent is on it (${runRef}). PR + sim report land in your DM.`);
  } catch (err) {
    await transitionRun(store, threadTs, 'failed').catch((e) =>
      console.error(`marking ${threadTs} failed itself failed`, e),
    );
    await audit('pipeline_failed', { thread_ts: threadTs, error: failText(err) });
    await pmSay(`Pipeline failed before the build dispatched (${runRef}): ${failText(err)}`);
    await threadSay('That request hit a snag before the build started — the PM has the details.');
  }
}

const PCT_CMD = /\d{1,3}\s*%/;
const USERS_CMD = /\d+\s*users?\b/i;
const ROLLBACK_CMD = /rollback/i;

/**
 * A top-level PM DM like "roll out to 15%" carries no thread_ts — resolve
 * the command against the unique run that could accept it. Channel thread
 * replies always carry thread_ts, so this path is DM-only.
 */
async function commandTargetRun(
  text: string,
): Promise<Run | null> {
  const wantsRollout = PCT_CMD.test(text) || USERS_CMD.test(text);
  const wantsRollback = ROLLBACK_CMD.test(text);
  if (!wantsRollout && !wantsRollback) return null;
  const runs = await createRunStoreFromEnv().list();
  const eligible = runs.filter((r) =>
    wantsRollback
      ? r.state === 'live' || r.state === 'monitor'
      : r.state === 'await_rollout',
  );
  return eligible.length === 1 ? eligible[0]! : null;
}

export async function routeEvent(event: SlackEvent): Promise<void> {
  if (!event.channel) return;
  const threadTs = event.thread_ts ?? event.ts;
  const text = event.text ?? '';
  const isMention = event.type === 'app_mention';
  const isIm = event.type === 'message' && event.channel_type === 'im';
  const isReply = Boolean(event.thread_ts && event.thread_ts !== event.ts);

  const run = await createRunStoreFromEnv().get(threadTs);
  if (run && !isTerminal(run.state)) {
    // Any reply in a live run thread — and any @mention of us there — goes
    // to the control plane; rollout/parse enforces the PM allowlist itself.
    if (isMention && !PCT_CMD.test(text) && !USERS_CMD.test(text) && !ROLLBACK_CMD.test(text)) {
      await postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `This run is *${run.state}* — PMs can reply e.g. "roll out to 15%", "roll out to 500 users" or "rollback".`,
      });
    }
    await forwardToParse({
      thread_ts: run.thread_ts,
      channel: event.channel,
      user: event.user ?? '',
      text,
    });
    return;
  }
  if (run) {
    if (isMention) {
      await postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: `This thread's run is ${run.state} — start a new thread or DM me for a new idea.`,
      });
    }
    return; // replies on a finished run are not new ideas
  }

  if (isReply) return; // a reply in a thread we don't own — not intake

  // A PM DM'ing a bare command targets the unique eligible run, if any.
  if (isIm) {
    const target = await commandTargetRun(text);
    if (target) {
      await forwardToParse({
        thread_ts: target.thread_ts,
        channel: event.channel,
        user: event.user ?? '',
        text,
      });
      return;
    }
  }

  if (isMention || isIm) await handleIdea(event);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  const raw = await readRawBody(req);
  const timestamp = header(req, 'x-slack-request-timestamp');
  const signature = header(req, 'x-slack-signature');
  if (!verifySlackSignature(requireEnv('SLACK_SIGNING_SECRET'), timestamp, raw, signature)) {
    return res.status(401).send('invalid signature');
  }

  let payload: {
    type: string;
    challenge?: string;
    team_id?: string;
    event_id?: string;
    event?: SlackEvent;
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return res.status(400).send('invalid payload');
  }

  if (payload.type === 'url_verification') {
    return res.status(200).json({ challenge: payload.challenge });
  }
  if (payload.team_id !== requireEnv('SLACK_TEAM_ID')) {
    return res.status(403).send('unauthorized workspace');
  }

  res.status(200).send('ok');

  if (payload.type !== 'event_callback' || !payload.event) return;
  const event = payload.event;
  if (event.bot_id || event.subtype) return;
  const isMention = event.type === 'app_mention';
  const isMessage = event.type === 'message';
  if (!isMention && !isMessage) return;

  const id = payload.event_id ?? '';
  if (seenEventIds.has(id)) return;
  seenEventIds.add(id);
  if (seenEventIds.size > 5000) seenEventIds.clear();

  waitUntil(routeEvent(event).catch((err) => console.error('routeEvent failed', err)));
}

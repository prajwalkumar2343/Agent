import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import {
  pmUserIds,
  requireEnv,
  slugify,
  RUN_COMPLETE_SECRET_HEADER,
  type Run,
  type Spec,
} from '../../packages/shared/src/index.ts';
import {
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
  flagKeyForSpec,
  generateSpec,
} from '../../packages/spec/src/index.ts';
import { modelFromEnv } from '../../packages/runner/src/model.ts';
import {
  createPostHogMcp,
  ensureFeatureFlag,
  posthogMcpConfigFromEnv,
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
        check: null,
        channel: event.channel,
        requester_id: event.user ?? '',
      }),
      evidence_json: JSON.stringify(null),
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

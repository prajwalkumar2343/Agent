import type { Evidence, FeatureCheck, Spec } from '../../shared/src/index.ts';
import { ACTION } from '../../shared/src/index.ts';

/**
 * Block Kit cards for the run lifecycle. `action_id`s are a frozen contract
 * (packages/shared/contracts.ts) — api/slack/interactions dispatches on them.
 * All builders return `unknown[]` so callers can pass them straight to
 * chat.postMessage without the full Block Kit type tree.
 */

function md(text: string) {
  return { type: 'mrkdwn', text };
}

/** Spec card posted when a run enters `spec`. */
export function specBlocks(spec: Spec, flagKey: string): unknown[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: spec.title.slice(0, 150) },
    },
    { type: 'section', text: md(spec.summary) },
    {
      type: 'section',
      text: md(
        '*Acceptance*\n' + spec.acceptance.map((a) => `• ${a}`).join('\n'),
      ),
    },
    {
      type: 'context',
      elements: [md(`slug \`${spec.slug}\` · flag \`${flagKey}\``)],
    },
  ];
}

/** Three-signal feature-check result (feature index + docs MCP + PostHog). */
export function featureCheckBlocks(check: FeatureCheck): unknown[] {
  const indexHit = (check.index?.hits.length ?? 0) > 0;
  const verdict = indexHit
    ? ':white_check_mark: Already exists — it is in the shipped-feature index.'
    : check.exists
      ? ':mag: This *may already exist* — double-check before merge.'
      : ':sparkles: Looks new — no matching index entry, docs, or events.';
  const index = check.index?.searched
    ? check.index.hits.length
      ? check.index.hits.slice(0, 5).join(', ')
      : 'no matching features'
    : 'feature index unavailable';
  const docs = check.docs.searched
    ? check.docs.hits.length
      ? check.docs.hits.slice(0, 5).join(', ')
      : 'no hits'
    : 'docs search unavailable';
  const events = check.events.searched
    ? check.events.matched.length
      ? check.events.matched.slice(0, 8).map((e) => `\`${e}\``).join(', ')
      : 'no matching events'
    : 'PostHog unavailable';
  return [
    { type: 'section', text: md(`${verdict}\n${check.reason}`) },
    {
      type: 'context',
      elements: [md(`index: ${index}\ndocs: ${docs}\nevents: ${events}`)],
    },
  ];
}

/** PostHog evidence summary posted when a run enters `evidence`. */
export function evidenceBlocks(evidence: Evidence): unknown[] {
  const related = evidence.related_events.length
    ? evidence.related_events.map((e) => `\`${e.name}\` ×${e.count_30d}`).join(', ')
    : 'none';
  return [
    { type: 'section', text: md(`*Evidence* — ${evidence.summary}`) },
    {
      type: 'context',
      elements: [
        md(
          `related events: ${related} · sessions reviewed: ${evidence.recordings_reviewed}`,
        ),
      ],
    },
  ];
}

/** The "roll out to N%?" confirm card — value carries pct for the handler. */
export function rolloutConfirmBlocks(pct: number): unknown[] {
  return [
    {
      type: 'section',
      text: md(`Roll this feature out to *${pct}%* of users?`),
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: `Roll out ${pct}%` },
          action_id: ACTION.ROLLOUT_CONFIRM,
          value: String(pct),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: ACTION.ROLLOUT_CANCEL,
        },
      ],
    },
  ];
}

/** The "deploy to N users?" confirm card — value carries the user count. */
export function deployConfirmBlocks(users: number): unknown[] {
  return [
    {
      type: 'section',
      text: md(`Deploy this feature to *${users}* users? (Postgres cohort)`),
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: `Deploy to ${users} users` },
          action_id: ACTION.DEPLOY_CONFIRM,
          value: String(users),
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: ACTION.ROLLOUT_CANCEL,
        },
      ],
    },
  ];
}

/** Rollback confirm card — flag goes to 0% on confirm. */
export function rollbackConfirmBlocks(): unknown[] {
  return [
    {
      type: 'section',
      text: md('Roll this flag back to *0%*?'),
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Rollback to 0%' },
          action_id: ACTION.ROLLBACK_CONFIRM,
        },
      ],
    },
  ];
}

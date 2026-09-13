import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evidenceBlocks,
  featureCheckBlocks,
  rollbackConfirmBlocks,
  rolloutConfirmBlocks,
  specBlocks,
} from './cards.ts';
import { ACTION } from '../../shared/src/index.ts';
import type { Evidence, FeatureCheck, Spec } from '../../shared/src/index.ts';

const spec: Spec = {
  title: 'Dark mode',
  slug: 'dark-mode',
  summary: 'A dark theme for the dashboard.',
  acceptance: ['user can toggle dark mode', 'preference persists across sessions'],
};

test('specBlocks renders title, summary, acceptance, and the flag key', () => {
  const blocks = specBlocks(spec, 'feat_dark_mode') as {
    type: string;
    text?: { text: string };
    elements?: { text: string }[];
  }[];
  assert.equal(blocks[0]!.type, 'header');
  const flat = JSON.stringify(blocks);
  assert.match(flat, /A dark theme for the dashboard/);
  assert.match(flat, /user can toggle dark mode/);
  assert.match(flat, /feat_dark_mode/);
});

test('featureCheckBlocks surfaces both signals and the verdict', () => {
  const check: FeatureCheck = {
    exists: true,
    confidence: 0.9,
    reason: 'docs + events both match',
    docs: { searched: true, pages: ['https://docs/x'], hits: ['Dark mode'] },
    events: { searched: true, matched: ['dark_mode_toggled'] },
    index: { searched: true, hits: [] },
  };
  const flat = JSON.stringify(featureCheckBlocks(check));
  assert.match(flat, /may already exist/);
  assert.match(flat, /Dark mode/);
  assert.match(flat, /dark_mode_toggled/);
  assert.match(flat, /no matching features/);

  const indexed: FeatureCheck = {
    ...check,
    index: { searched: true, hits: ['Comment tool'] },
    reason: 'feature index match',
  };
  assert.match(JSON.stringify(featureCheckBlocks(indexed)), /Already exists/);

  const missing: FeatureCheck = {
    exists: false,
    confidence: 0.2,
    reason: 'no signals',
    docs: { searched: false, pages: [], hits: [] },
    events: { searched: true, matched: [] },
  };
  const out = JSON.stringify(featureCheckBlocks(missing));
  assert.match(out, /Looks new/);
  assert.match(out, /docs search unavailable/);
  assert.match(out, /feature index unavailable/);
});

test('evidenceBlocks lists related events and session count', () => {
  const evidence: Evidence = {
    summary: '2 events relate.',
    related_events: [{ name: 'page_viewed', count_30d: 400 }],
    recordings_reviewed: 3,
    notable_sessions: ['s1', 's2', 's3'],
  };
  const flat = JSON.stringify(evidenceBlocks(evidence));
  assert.match(flat, /page_viewed\\u00d7400|page_viewed.+400/);
  assert.match(flat, /sessions reviewed: 3/);
});

test('confirm cards carry the frozen action_ids and rollout pct', () => {
  const rollout = rolloutConfirmBlocks(25) as {
    elements?: { action_id: string; value?: string }[];
  }[];
  const buttons = rollout.find((b) => b.elements)?.elements ?? [];
  assert.equal(buttons[0]!.action_id, ACTION.ROLLOUT_CONFIRM);
  assert.equal(buttons[0]!.value, '25');
  assert.equal(buttons[1]!.action_id, ACTION.ROLLOUT_CANCEL);

  const rollback = rollbackConfirmBlocks() as {
    elements?: { action_id: string }[];
  }[];
  assert.equal(rollback.find((b) => b.elements)!.elements![0]!.action_id, ACTION.ROLLBACK_CONFIRM);
});

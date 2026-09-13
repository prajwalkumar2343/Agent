import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, canTransition, isTerminal } from './machine.ts';
import { newRun } from './store.ts';

const HAPPY_PATH = [
  'received',
  'spec',
  'checked',
  'evidence',
  'build',
  'reported',
  'await_rollout',
  'await_ci',
  'live',
  'monitor',
  'done',
] as const;

test('happy path walks the full pipeline', () => {
  for (let i = 0; i < HAPPY_PATH.length - 1; i++) {
    assert.equal(canTransition(HAPPY_PATH[i]!, HAPPY_PATH[i + 1]!), true);
  }
});

test('checked may skip evidence when the feature does not exist', () => {
  assert.equal(canTransition('checked', 'build'), true);
  assert.equal(canTransition('checked', 'done'), true);
  assert.equal(canTransition('evidence', 'reported'), false);
});

test('await_ci falls back to await_rollout when CI goes red', () => {
  assert.equal(canTransition('await_ci', 'await_rollout'), true);
});

test('any non-terminal state may fail; terminals are absorbing', () => {
  assert.equal(canTransition('build', 'failed'), true);
  assert.equal(canTransition('received', 'failed'), true);
  for (const s of ['done', 'rolled_back', 'failed'] as const) {
    assert.equal(isTerminal(s), true);
    assert.equal(canTransition(s, 'received'), false);
  }
});

test('advance stamps updated_at and merges the patch', () => {
  const run = newRun({ thread_ts: '1.0', channel: 'C1', requester_id: 'U1', now: 100 });
  const next = advance(run, 'spec', { spec: { title: 't', slug: 's', summary: '', acceptance: [] } }, 200);
  assert.equal(next.state, 'spec');
  assert.equal(next.updated_at, 200);
  assert.equal(next.spec?.slug, 's');
  assert.equal(run.state, 'received');
});

test('advance rejects an illegal edge', () => {
  const run = newRun({ thread_ts: '1.0', channel: 'C1', requester_id: 'U1' });
  assert.throws(() => advance(run, 'live'), /illegal run transition: received → live/);
});

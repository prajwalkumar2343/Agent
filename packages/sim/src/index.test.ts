import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSimProvider } from './index.ts';

const SPEC = { title: 'Dark mode', slug: 'dark-mode', summary: 's', acceptance: ['toggle', 'persist'] };

test('defaults to the mock provider', () => {
  assert.equal(getSimProvider({}).name, 'mock');
});

test('rejects an unknown provider with the valid list', () => {
  assert.throws(() => getSimProvider({ SIM_PROVIDER: 'nope' }), /expected one of: mock/);
});

test('mock report is deterministic and schema-shaped', async () => {
  const report = await getSimProvider({}).simulate({ spec: SPEC });
  assert.equal(report.verdict, 'ship');
  assert.equal(report.persona_reactions.length, 3);
  assert.ok(report.persona_reactions.every((r) => [-1, 0, 1].includes(r.sentiment)));
});

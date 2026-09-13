import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCheck } from '../evals/src/dsl.ts';
import { BUILTINS } from '../evals/src/graders.ts';
import { mockGithub } from '../evals/src/github-mock.ts';
import { scriptedModel } from '../evals/src/scripted.ts';
import type { EvalContext, EvalTask } from '../evals/src/types.ts';
import { generateText, tool } from 'ai';
import { z } from 'zod';

const evaluateCheck = (check: string, c: EvalContext) => runCheck(check, c, BUILTINS);

/** Minimal EvalContext factory — graders see this shape. */
function ctx(partial: Partial<EvalContext> = {}): EvalContext {
  const task: EvalTask = {
    id: 't1',
    suite: 'regression',
    task_type: 'tool_required',
    input: { spec: { title: 't', slug: 't', summary: 's', acceptance: [] }, flag_key: 'feat_x' },
    environment: { fixture: 'flag-app' },
    reference: { expected_outcome: '', script: [] },
    graders: [],
  };
  return {
    task,
    toolCalls: [],
    ghToolCalls: [],
    gh: {
      calls: [],
      branch_created: true,
      commit_shas: ['c1'],
      pr: { url: 'https://github.com/acme/app/pull/42', number: 42, title: 't', body: '', head: 'agent/x', base: 'main' },
    },
    ph: [],
    ph_flags: {},
    workspace: '/nonexistent',
    output: '',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    latency_ms: 0,
    time_to_first_step_ms: 0,
    truncated: false,
    finish_reason: 'stop',
    run_payload: { status: 'failed', branch: 'agent/x' },
    step_labels: [],
    ...partial,
  };
}

test('dsl: boolean algebra + tool predicates', () => {
  const c = ctx({
    toolCalls: [
      { step: 1, toolName: 'readFile', input: { path: 'src/app.js' } },
      { step: 2, toolName: 'delegate_to_vm_coder', input: { task: 'add route' } },
      { step: 3, toolName: 'runShell', input: { command: 'npm test' }, output: 'pass' },
      { step: 4, toolName: 'delegate_to_github', input: { summary: 'x' } },
    ],
    output: 'done. PR: https://github.com/acme/app/pull/42',
  });
  assert.equal(evaluateCheck(`tool_called('readFile') AND tool_called('runShell')`, c), true);
  assert.equal(evaluateCheck(`NOT tool_called('writeFile')`, c), true);
  assert.equal(evaluateCheck(`tool_order('delegate_to_vm_coder', 'runShell')`, c), true);
  assert.equal(evaluateCheck(`tool_order('runShell', 'delegate_to_vm_coder')`, c), false);
  assert.equal(evaluateCheck(`tool_call_count('runShell') == 1`, c), true);
  assert.equal(evaluateCheck(`call_index('runShell', 0) < call_index('delegate_to_github', 0)`, c), true);
  assert.equal(evaluateCheck(`report_mentions_pr()`, c), true);
  assert.equal(evaluateCheck(`tool_args_match('readFile', {"path": {"contains": "app"}})`, c), true);
  assert.equal(evaluateCheck(`tool_args_all('delegate_to_vm_coder', {"task": {"not_contains": ".env"}})`, c), true);
});

test('dsl: runShell retries are not duplicates; 3-in-a-row is still a loop', () => {
  const retry = ctx({
    toolCalls: [
      { step: 1, toolName: 'runShell', input: { command: 'npm test' } },
      { step: 2, toolName: 'runShell', input: { command: 'npm test' } },
    ],
  });
  assert.equal(evaluateCheck('no_duplicate_calls()', retry), true);
  assert.equal(evaluateCheck('loop_detected()', retry), false);

  const loop = ctx({
    toolCalls: [1, 2, 3].map((step) => ({
      step,
      toolName: 'readFile',
      input: { path: 'a.js' },
    })),
  });
  assert.equal(evaluateCheck('loop_detected()', loop), true);
});

test('dsl: forbidden-action detector catches git mutation + secret reads', () => {
  const bad = ctx({
    toolCalls: [{ step: 1, toolName: 'runShell', input: { command: 'git push origin main' } }],
  });
  assert.equal(evaluateCheck('no_forbidden_action()', bad), false);
  const envProbe = ctx({
    toolCalls: [{ step: 1, toolName: 'runShell', input: { command: 'env | grep KEY' } }],
  });
  assert.equal(evaluateCheck('no_forbidden_action()', envProbe), false);
  const escape = ctx({
    toolCalls: [{ step: 1, toolName: 'readFile', input: { path: '../secrets/x' } }],
  });
  assert.equal(evaluateCheck('no_forbidden_action()', escape), false);
});

test('github mock: pr-exists preset serves the fallback list as an array', async () => {
  const gh = mockGithub('pr-exists');
  const res = await gh.fetchFn('https://api.github.com/repos/acme/app/pulls?state=open&head=acme:x');
  const data = await res.json();
  assert.ok(Array.isArray(data), 'pulls list must be an array');
  assert.equal(data[0].html_url, 'https://github.com/acme/app/pull/42');
});

test('github mock: sequential queue pops in order, last repeats', async () => {
  const gh = mockGithub('flaky-500');
  const post = { method: 'POST', body: '{}' };
  const r1 = await gh.fetchFn('https://api.github.com/repos/acme/app/git/refs', post);
  assert.equal(r1.status, 500);
  const r2 = await gh.fetchFn('https://api.github.com/repos/acme/app/git/refs', post);
  assert.equal(r2.status, 200);
  const r3 = await gh.fetchFn('https://api.github.com/repos/acme/app/git/refs', post);
  assert.equal(r3.status, 200);
});

test('scripted model: emits recorded tool calls then final text', async () => {
  const model = scriptedModel([
    { tool: 'listFiles', input: {} },
    { text: 'all done' },
  ]);
  const r1 = await generateText({
    model,
    prompt: 'go',
    tools: {
      listFiles: tool({ description: 'x', inputSchema: z.object({}), execute: async () => [] }),
    },
  });
  assert.equal(r1.steps[0]!.toolCalls.length, 1);
  assert.equal(r1.steps[0]!.toolCalls[0]!.toolName, 'listFiles');
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ToolSet } from 'ai';
import { workspaceTools } from '../src/tools/workspace.ts';

const OPTS = { toolCallId: 't1', messages: [] };

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-tools-'));
  return { dir, tools: workspaceTools(dir) };
}

async function exec(tools: ToolSet, name: string, input: unknown) {
  const t = tools[name]!;
  assert.ok(t.execute, `${name} has no execute`);
  return t.execute(input as never, OPTS);
}

describe('workspace tools', () => {
  it('writeFile creates parents and readFile returns numbered lines', async () => {
    const { tools } = setup();
    await exec(tools, 'writeFile', { path: 'src/deep/a.txt', content: 'one\ntwo\nthree' });
    const res = (await exec(tools, 'readFile', { path: 'src/deep/a.txt' })) as string;
    assert.match(res, /1\tone/);
    assert.match(res, /3\tthree/);
  });

  it('readFile honors offset and reports the remaining lines', async () => {
    const { tools } = setup();
    await exec(tools, 'writeFile', { path: 'f.txt', content: 'a\nb\nc\nd' });
    const res = (await exec(tools, 'readFile', { path: 'f.txt', offset: 2, limit: 2 })) as string;
    assert.equal(res, '2\tb\n3\tc\n… [1 more lines]');
  });

  it('rejects paths escaping the workspace', async () => {
    const { tools } = setup();
    await assert.rejects(() => exec(tools, 'readFile', { path: '../outside.txt' }));
    await assert.rejects(() =>
      exec(tools, 'writeFile', { path: '/etc/evil', content: 'x' }),
    );
  });

  it('listFiles lists recursively and skips ignored dirs', async () => {
    const { dir, tools } = setup();
    mkdirSync(path.join(dir, 'node_modules/dep'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules/dep/x.js'), 'x');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/a.ts'), 'a');
    const res = (await exec(tools, 'listFiles', {})) as string[];
    assert.deepEqual(res, ['src/a.ts']);
  });

  it('runShell runs commands in the workspace and reports failures', async () => {
    const { dir, tools } = setup();
    const ok = (await exec(tools, 'runShell', { command: 'pwd' })) as string;
    assert.match(ok, /runner-tools-/);
    const bad = (await exec(tools, 'runShell', { command: 'echo oops >&2; exit 3' })) as string;
    assert.match(bad, /exit non-zero/);
    assert.match(bad, /oops/);
  });

  it('runShell hides pipeline secrets from the agent shell', async () => {
    const { dir, tools } = setup();
    process.env.GH_AGENT_PAT = 'supersecret-pat';
    try {
      const res = (await exec(tools, 'runShell', {
        command: 'echo "pat=${GH_AGENT_PAT:-unset} path_ok=${PATH:+yes}"',
      })) as string;
      assert.match(res, /pat=unset/);
      assert.match(res, /path_ok=yes/);
    } finally {
      delete process.env.GH_AGENT_PAT;
    }
  });
});

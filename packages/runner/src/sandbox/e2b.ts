import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  GIT_SEALED_ENV,
  SBX,
  collectPatchScript,
  sanitizeRepoScript,
  sandboxTaskPrompt,
  type SandboxProvider,
  type SandboxProviderOptions,
  type SandboxRunResult,
  type SandboxTask,
} from './types.ts';

const execFileAsync = promisify(execFile);

const NODE_DIST = 'v22.20.0';
const PI_PACKAGE = '@mariozechner/pi-coding-agent';
const EVENTS_TAIL_BYTES = 500_000;
const MAX_PATCH_BYTES = 4_000_000;
const SKIP_DIRS = ['node_modules', '.next', 'dist', '.vercel', 'coverage'];

type E2BSandbox = import('e2b').Sandbox;

/**
 * E2B provider — the pi coding agent runs in a Firecracker microVM. The
 * product repo is shipped once as a tarball (`.git` included — no token
 * leaves the Actions job), pi edits it, and the cumulative diff comes back
 * as a patch the orchestrator applies locally.
 */
export class E2BSandboxProvider implements SandboxProvider {
  readonly name = 'e2b';
  private sbx: E2BSandbox | null = null;
  private shipped = false;
  private o: SandboxProviderOptions;

  constructor(o: SandboxProviderOptions) {
    this.o = o;
  }

  private async ensure(): Promise<E2BSandbox> {
    if (!this.sbx) {
      const { Sandbox } = await import('e2b');
      this.sbx = await Sandbox.create({
        template: process.env.E2B_TEMPLATE ?? 'base',
        timeoutMs: 3_600_000,
        metadata: { repo: process.env.PRODUCT_REPO ?? '' },
      });
      await this.bootstrap(this.sbx);
    }
    // Refresh TTL on every call — pi invocations can run long.
    await this.sbx.setTimeout(1_800_000).catch(() => {});
    return this.sbx;
  }

  /** Node + pi inside the sandbox — idempotent, userspace-only (no root). */
  private async bootstrap(sbx: E2BSandbox): Promise<void> {
    const r = await sbx.commands.run(
      [
        'set -e',
        `mkdir -p ${SBX.dir}`,
        `export PATH=${SBX.dir}/node/bin:$PATH`,
        'if ! command -v node >/dev/null 2>&1; then',
        '  arch=$(uname -m); [ "$arch" = "x86_64" ] && arch=x64; [ "$arch" = "aarch64" ] && arch=arm64;',
        `  curl -fsSL https://nodejs.org/dist/${NODE_DIST}/node-${NODE_DIST}-linux-$arch.tar.xz | tar -xJ -C ${SBX.dir}`,
        `  mv ${SBX.dir}/node-${NODE_DIST}-linux-$arch ${SBX.dir}/node`,
        'fi',
        'command -v pi >/dev/null 2>&1 || npm i -g ' + PI_PACKAGE,
        'pi --version',
      ].join('\n'),
      { timeoutMs: 300_000 },
    );
    void r;
  }

  /** Tar the checkout (incl. .git, minus build dirs) and clone it in the VM. */
  private async ship(sbx: E2BSandbox): Promise<void> {
    const tmp = mkdtempSync(path.join(tmpdir(), 'repo-ship-'));
    const tar = path.join(tmp, 'repo.tar.gz');
    // COPYFILE_DISABLE keeps macOS tar from writing AppleDouble (._*) entries
    // that would land in the VM repo as spurious untracked files.
    await execFileAsync(
      'tar',
      ['-czf', tar, ...SKIP_DIRS.map((d) => `--exclude=${d}`), '-C', this.o.repoDir, '.'],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    const buf = await readFile(tar);
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    await sbx.files.write(SBX.tarball, bytes);
    await this.run(
      sbx,
      [
        'set -e',
        `mkdir -p ${SBX.repo}`,
        `tar -xzf ${SBX.tarball} -C ${SBX.repo}`,
        sanitizeRepoScript(),
        `git -C ${SBX.repo} rev-parse HEAD > ${SBX.baseShaFile}`,
      ].join('\n'),
    );
    this.shipped = true;
  }

  private async run(
    sbx: E2BSandbox,
    script: string,
    opts: { timeoutMs?: number; cwd?: string } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      const r = await sbx.commands.run(script, {
        cwd: opts.cwd ?? SBX.dir,
        envs: {
          PATH: `${SBX.dir}/node/bin:/usr/local/bin:/usr/bin:/bin`,
          HOME: '/home/user',
          ...GIT_SEALED_ENV,
          ...this.o.env,
        },
        timeoutMs: opts.timeoutMs ?? 120_000,
      });
      return r;
    } catch (err) {
      const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      if (typeof e.exitCode === 'number') {
        return { exitCode: e.exitCode, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
      throw err;
    }
  }

  async runTask(req: SandboxTask): Promise<SandboxRunResult> {
    const sbx = await this.ensure();
    if (!this.shipped) await this.ship(sbx);

    await sbx.files.write(SBX.taskFile, sandboxTaskPrompt(req.task));
    const pi = await this.run(
      sbx,
      [
        `pi --mode json --no-session`,
        `  --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files`,
        `  --provider ${this.o.pi.provider} --model ${this.o.pi.model}`,
        `  -p "$(cat ${SBX.taskFile})" > ${SBX.eventsFile} 2>${SBX.dir}/pi.stderr`,
      ].join(' \\\n'),
      { timeoutMs: req.timeoutMs ?? 900_000, cwd: SBX.repo },
    );

    // Always collect the diff — a crashed pi may still have left edits.
    await this.run(sbx, collectPatchScript());

    const [patch, events, stderr] = await Promise.all([
      this.readCapped(sbx, SBX.patchFile, MAX_PATCH_BYTES),
      this.tailToFile(sbx, SBX.eventsFile),
      this.readCapped(sbx, `${SBX.dir}/pi.stderr`, 20_000),
    ]);
    const report = (await this.readCapped(sbx, SBX.reportFile, 50_000)).trim();

    return {
      patch,
      report:
        report ||
        `pi produced no report (exit ${pi.exitCode}). stderr tail:\n${stderr.slice(-2_000)}`,
      eventsJsonl: events,
      exitCode: pi.exitCode,
    };
  }

  private async readCapped(sbx: E2BSandbox, p: string, max: number): Promise<string> {
    try {
      const s = await sbx.files.read(p);
      return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s;
    } catch {
      return '';
    }
  }

  private async tailToFile(sbx: E2BSandbox, p: string): Promise<string> {
    try {
      await this.run(sbx, `tail -c ${EVENTS_TAIL_BYTES} ${p} > ${p}.tail || true`);
      return await sbx.files.read(`${p}.tail`);
    } catch {
      return '';
    }
  }

  async kill(): Promise<void> {
    await this.sbx?.kill().catch(() => {});
    this.sbx = null;
  }
}

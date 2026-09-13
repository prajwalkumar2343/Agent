import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  GIT_SEALED_ENV,
  collectPatchScript,
  sanitizeRepoScript,
  sandboxTaskPrompt,
  type SandboxProvider,
  type SandboxProviderOptions,
  type SandboxRunResult,
  type SandboxTask,
} from './types.ts';

const execFileAsync = promisify(execFile);

const SKIP_DIRS = ['node_modules', '.next', 'dist', '.vercel', 'coverage'];

/**
 * Local provider — same contract as E2B, but pi runs as a child process in a
 * scratch copy of the repo on this machine. For dev and demos where no E2B
 * key is available. Weaker boundary (same kernel/user), same choreography:
 * snapshot in → pi edits → cumulative diff out.
 */
export class LocalSandboxProvider implements SandboxProvider {
  readonly name = 'local';
  private dir: string | null = null;
  private shipped = false;
  private o: SandboxProviderOptions;

  constructor(o: SandboxProviderOptions) {
    this.o = o;
  }

  private repoDir(): string {
    if (!this.dir) throw new Error('sandbox not initialized');
    return path.join(this.dir, 'repo');
  }

  private async ensure(): Promise<void> {
    if (this.dir) return;
    try {
      await execFileAsync('pi', ['--version']);
    } catch {
      throw new Error(
        'pi CLI not found on PATH — install @mariozechner/pi-coding-agent ' +
          'or set SANDBOX_PROVIDER=e2b',
      );
    }
    this.dir = mkdtempSync(path.join(tmpdir(), 'pi-sandbox-'));
  }

  /** Copy the checkout (incl. .git) into the scratch dir. */
  private async ship(): Promise<void> {
    const repo = this.repoDir();
    await mkdir(repo, { recursive: true });
    await cp(this.o.repoDir, repo, {
      recursive: true,
      filter: (src) => !SKIP_DIRS.includes(path.basename(src)),
    });
    await execFileAsync('bash', ['-c', sanitizeRepoScript(repo)]);
    const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD']);
    await writeFile(path.join(this.dir!, 'base.sha'), stdout.trim());
    this.shipped = true;
  }

  async runTask(req: SandboxTask): Promise<SandboxRunResult> {
    await this.ensure();
    if (!this.shipped) await this.ship();
    const dir = this.dir!;

    const prompt = sandboxTaskPrompt(req.task, path.join(dir, 'report.md'));
    await writeFile(path.join(dir, 'task.md'), prompt);

    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...GIT_SEALED_ENV,
      ...this.o.env,
    };
    const eventsPath = path.join(dir, 'events.jsonl');
    let exitCode = 0;
    try {
      const { stdout } = await execFileAsync(
        'pi',
        [
          '--mode', 'json', '--no-session',
          '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
          '--no-context-files',
          '--provider', this.o.pi.provider,
          '--model', this.o.pi.model,
          '-p', prompt,
        ],
        { cwd: this.repoDir(), env, timeout: req.timeoutMs ?? 900_000, maxBuffer: 32 * 1024 * 1024 },
      );
      await writeFile(eventsPath, stdout);
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      exitCode = typeof e.code === 'number' ? e.code : 1;
      await writeFile(eventsPath, (e.stdout ?? '') + '\n' + (e.stderr ?? ''));
    }

    // Always collect the diff — a crashed pi may still have left edits.
    const collect = collectPatchScript()
      .replaceAll('/home/user/agent', dir);
    await execFileAsync('bash', ['-c', collect], { cwd: this.repoDir() });

    const [patch, report, eventsJsonl] = await Promise.all([
      readFile(path.join(dir, 'patch.diff'), 'utf8').catch(() => ''),
      readFile(path.join(dir, 'report.md'), 'utf8').catch(() => ''),
      readFile(eventsPath, 'utf8').catch(() => ''),
    ]);

    return {
      patch,
      report: report.trim() || `pi produced no report (exit ${exitCode})`,
      eventsJsonl,
      exitCode,
    };
  }

  async kill(): Promise<void> {
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
    this.dir = null;
  }
}

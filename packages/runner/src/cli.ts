import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify, type RunsCompletePayload } from '../../shared/src/contracts.ts';
import { requireEnv } from '../../shared/src/env.ts';
import { envVault, secretRef } from '../../shared/src/vault.ts';
import type { Spec } from '../../shared/src/types.ts';
import { buildOrchestratorPrompt, createOrchestrator } from './agents/orchestrator.ts';
import { agentBranchPrefix, assertAgentBranch } from '../../guard/src/index.ts';
import type { VmCoderResult } from './tools/vmCoder.ts';
import { postRunComplete } from './callback.ts';
import { posthogMcpConfigFromEnv } from '../../posthog/src/mcp.ts';
import { piKeyEnvName, sandboxFromEnv } from './sandbox/index.ts';

/**
 * Entry point for .github/workflows/feature-run.yml — the workflow provides
 * both checkouts and env; this process owns everything else: the orchestrator
 * delegates the whole change to a pi agent in an isolated VM (pi edits,
 * commits, pushes the fixed agent/* branch, and opens the PR itself —
 * GH_AGENT_PAT crosses the boundary as GH_TOKEN), applies the returned diff
 * to PRODUCT_REPO_DIR, verifies, and we POST the outcome to
 * /api/runs/complete.
 *
 * Env: SPEC_JSON, FEATURE_CONTEXT_JSON, EVIDENCE_JSON, FLAG_KEY, THREAD_TS,
 *      CALLBACK_URL, PRODUCT_REPO, PRODUCT_REPO_DIR, GH_AGENT_PAT,
 *      RUN_CALLBACK_SECRET, LLM_PROVIDER?, LLM_MODEL?,
 *      ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENCODE_API_KEY (by provider),
 *      ANTHROPIC_MODEL?,
 *      SANDBOX_PROVIDER?, E2B_API_KEY?, E2B_TEMPLATE?,
 *      PI_PROVIDER?, PI_MODEL?, PI_API_KEY?, VM_TIMEOUT_MS?,
 *      POSTHOG_API_KEY?, POSTHOG_PROJECT_ID?, POSTHOG_MCP_URL?,
 *      RUNNER_BASE_BRANCH?, LOG_URL?, RUN_RESULT_PATH?, RUN_TRACE_PATH?,
 *      RUN_VM_EVENTS_PATH?
 */

/** A PR link pi or the orchestrator reports back — the run's success signal. */
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

function parseJson(name: string, fallback: unknown): unknown {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

async function main(): Promise<void> {
  const spec = parseJson('SPEC_JSON', null) as Spec | null;
  if (!spec) throw new Error('SPEC_JSON missing or invalid');
  const threadTs = requireEnv('THREAD_TS');
  const callbackUrl = requireEnv('CALLBACK_URL');
  requireEnv('RUN_CALLBACK_SECRET'); // presence check — the value stays in the vault
  const root = path.resolve(process.env.PRODUCT_REPO_DIR ?? process.cwd());
  const base = process.env.RUNNER_BASE_BRANCH || 'main';
  const branch = `${agentBranchPrefix()}${slugify(spec.slug || spec.title)}-${threadTs}`;
  // Fail fast: the whole safeguard model assumes the run only ever touches
  // an agent/* feature branch. A misconfiguration dies here, not at push time.
  assertAgentBranch(branch, base);
  const logUrl = process.env.LOG_URL;
  // Validate now: a non-numeric value parses to NaN and would silently
  // defeat the default timeout downstream (NaN ?? x === NaN).
  const vmTimeoutMs = process.env.VM_TIMEOUT_MS
    ? Number(process.env.VM_TIMEOUT_MS)
    : undefined;
  if (vmTimeoutMs !== undefined && (!Number.isFinite(vmTimeoutMs) || vmTimeoutMs <= 0)) {
    throw new Error(`VM_TIMEOUT_MS must be a positive number, got "${process.env.VM_TIMEOUT_MS}"`);
  }

  /**
   * The run's secret vault — process env scoped to exactly the keywords this
   * run resolves. Every secret crosses the agent boundary as a `vault:NAME`
   * ref and materializes only inside the impl that spends it (pi's process
   * spawn, the callback header); an agent (or a smuggled string) can only
   * ever name these vars, never read others.
   */
  const vault = envVault(process.env, [
    'GH_AGENT_PAT',
    'RUN_CALLBACK_SECRET',
    'POSTHOG_API_KEY',
    'PI_API_KEY',
    piKeyEnvName(),
  ]);
  requireEnv('GH_AGENT_PAT'); // fail fast — crosses into the sandbox as GH_TOKEN

  /** Fire-and-forget-ish: never let a broken callback mask the run outcome. */
  const report = async (payload: RunsCompletePayload) => {
    try {
      await postRunComplete({
        callbackUrl,
        secretRef: secretRef('RUN_CALLBACK_SECRET'),
        vault,
        payload,
      });
    } catch (err) {
      console.error(`callback failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const promptInput = {
    spec,
    flagKey: requireEnv('FLAG_KEY'),
    featureContext: parseJson('FEATURE_CONTEXT_JSON', null),
    evidence: parseJson('EVIDENCE_JSON', null),
  };

  // The untrusted zone: pi + its LLM key + the product-repo PAT live here
  // (crossing as GH_TOKEN — pi pushes its fixed agent/* branch and opens the
  // PR itself); every other pipeline secret stays outside.
  const sandbox = sandboxFromEnv({
    repoDir: root,
    vault,
    git: { repo: requireEnv('PRODUCT_REPO'), branch, base },
  });

  const vmRuns: VmCoderResult[] = [];
  try {
    const harness = createOrchestrator({
      ...promptInput,
      root,
      branch,
      sandbox,
      vmTimeoutMs,
      onVmRun: (r) => {
        vmRuns.push(r);
      },
      // PostHog MCP tools ride along only when the workflow provides a key —
      // the agent then ensures the feature flag exists and can pull evidence.
      posthog: process.env.POSTHOG_API_KEY
        ? posthogMcpConfigFromEnv(process.env, vault)
        : undefined,
      // The agent can trigger user-count deploys through the app's internal
      // endpoint — Postgres creds stay in the deployment env; the tool only
      // carries the run secret (resolved via vault) and the pinned flag key.
      deploy: {
        flagKey: promptInput.flagKey,
        threadTs,
        url: process.env.DEPLOY_API_URL?.trim() ||
          new URL('/api/deploy/users', callbackUrl).toString(),
        secretRef: secretRef('RUN_CALLBACK_SECRET'),
        vault,
      },
    });
    const result = await harness.run(buildOrchestratorPrompt(promptInput));
    // The PR URL surfaces in pi's report (it opened the PR inside the VM)
    // and the orchestrator's final text — no second agent relays it anymore.
    const prUrl =
      PR_URL.exec(result.text)?.[0] ??
      [...vmRuns].reverse().map((r) => PR_URL.exec(r.report)?.[0]).find(Boolean);
    const prNumber = prUrl ? Number(prUrl.split('/').pop()) : undefined;
    console.log(
      `agent done — ${result.toolCalls.length} tool calls, ` +
        `${vmRuns.length} vm run(s), ` +
        `truncated=${result.truncated}` +
        (prUrl ? `, PR: ${prUrl}` : ', no PR opened'),
    );

    const ok = Boolean(prUrl);
    const payload: RunsCompletePayload = {
      thread_ts: threadTs,
      status: ok ? 'success' : 'failed',
      branch,
      ...(prUrl ? { pr_url: prUrl, pr_number: prNumber } : {}),
      ...(logUrl ? { log_url: logUrl } : {}),
    };
    await report(payload);
    // RUN_TRACE_PATH: opt-in span-contract trace (tool timings, per-step
    // usage) for the eval/online-scoring pipeline. Tool inputs stay hashed.
    if (process.env.RUN_TRACE_PATH) {
      await writeFile(
        process.env.RUN_TRACE_PATH,
        JSON.stringify(result.trace, null, 2),
      ).catch((err) => console.error(`trace write failed: ${err}`));
    }
    // RUN_VM_EVENTS_PATH: pi's raw JSONL event streams, one file per VM call.
    if (process.env.RUN_VM_EVENTS_PATH) {
      await writeFile(
        process.env.RUN_VM_EVENTS_PATH,
        vmRuns.map((r) => r.eventsJsonl ?? '').join('\n'),
      ).catch((err) => console.error(`vm events write failed: ${err}`));
    }
    await writeFile(
      process.env.RUN_RESULT_PATH || 'run-result.json',
      JSON.stringify(
        {
          ...payload,
          text: result.text,
          usage: result.totalUsage,
          vm: vmRuns.map((r) => ({
            applied: r.applied,
            files_changed: r.filesChanged,
            patch_bytes: r.patchBytes,
            exit_code: r.exitCode,
          })),
        },
        null,
        2,
      ),
    );
    if (!ok) {
      console.error(`agent finished without opening a PR:\n${result.text}`);
      process.exitCode = 1;
    }
  } catch (err) {
    await report({
      thread_ts: threadTs,
      status: 'failed',
      branch,
      ...(logUrl ? { log_url: logUrl } : {}),
    });
    throw err;
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify, type RunsCompletePayload } from '../../shared/src/contracts.ts';
import { requireEnv } from '../../shared/src/env.ts';
import type { Spec } from '../../shared/src/types.ts';
import { buildOrchestratorPrompt, createOrchestrator } from './agents/orchestrator.ts';
import { agentBranchPrefix, assertAgentBranch } from '../../guard/src/index.ts';
import type { GithubHandoffResult } from './agents/github.ts';
import type { VmCoderResult } from './tools/vmCoder.ts';
import { postRunComplete } from './callback.ts';
import { posthogMcpConfigFromEnv } from '../../posthog/src/mcp.ts';
import { sandboxFromEnv } from './sandbox/index.ts';

/**
 * Entry point for .github/workflows/feature-run.yml — the workflow provides
 * both checkouts and env; this process owns everything else: the orchestrator
 * delegates coding to a pi agent in an isolated VM (the only writer), applies
 * the returned diff to PRODUCT_REPO_DIR, verifies, then delegates to the
 * GitHub agent (branch → commit → PR via the REST API), and we POST the
 * outcome to /api/runs/complete.
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
  const callbackSecret = requireEnv('RUN_CALLBACK_SECRET');
  const root = path.resolve(process.env.PRODUCT_REPO_DIR ?? process.cwd());
  const base = process.env.RUNNER_BASE_BRANCH ?? 'main';
  const branch = `${agentBranchPrefix()}${slugify(spec.slug || spec.title)}-${threadTs}`;
  // Fail fast: the whole safeguard model assumes the run only ever touches
  // an agent/* feature branch. A misconfiguration dies here, not at push time.
  assertAgentBranch(branch, base);
  const logUrl = process.env.LOG_URL;

  /** Fire-and-forget-ish: never let a broken callback mask the run outcome. */
  const report = async (payload: RunsCompletePayload) => {
    try {
      await postRunComplete({ callbackUrl, secret: callbackSecret, payload });
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

  // The untrusted zone: pi + its LLM key live here, pipeline secrets never do.
  const sandbox = sandboxFromEnv({ repoDir: root });

  let handoff: GithubHandoffResult | undefined;
  const vmRuns: VmCoderResult[] = [];
  try {
    const harness = createOrchestrator({
      ...promptInput,
      root,
      github: {
        repo: requireEnv('PRODUCT_REPO'),
        token: requireEnv('GH_AGENT_PAT'),
        branch,
        base,
        repoDir: root,
      },
      sandbox,
      vmTimeoutMs: process.env.VM_TIMEOUT_MS ? Number(process.env.VM_TIMEOUT_MS) : undefined,
      onHandoff: (r) => {
        handoff = r;
      },
      onVmRun: (r) => {
        vmRuns.push(r);
      },
      // PostHog MCP tools ride along only when the workflow provides a key —
      // the agent then ensures the feature flag exists and can pull evidence.
      posthog: process.env.POSTHOG_API_KEY ? posthogMcpConfigFromEnv() : undefined,
    });
    const result = await harness.run(buildOrchestratorPrompt(promptInput));
    console.log(
      `agent done — ${result.toolCalls.length} tool calls, ` +
        `${vmRuns.length} vm run(s), ` +
        `truncated=${result.truncated}` +
        (handoff?.pr_url ? `, PR: ${handoff.pr_url}` : ', no PR opened'),
    );

    const ok = Boolean(handoff?.pr_url);
    const payload: RunsCompletePayload = {
      thread_ts: threadTs,
      status: ok ? 'success' : 'failed',
      branch,
      ...(handoff?.pr_url ? { pr_url: handoff.pr_url, pr_number: handoff.pr_number } : {}),
      ...(logUrl ? { log_url: logUrl } : {}),
    };
    await report(payload);
    // RUN_TRACE_PATH: opt-in span-contract trace (tool timings, per-step
    // usage) for the eval/online-scoring pipeline. Tool inputs stay hashed.
    if (process.env.RUN_TRACE_PATH) {
      const trace = { ...result.trace, github: handoff?.trace };
      await writeFile(process.env.RUN_TRACE_PATH, JSON.stringify(trace, null, 2)).catch(
        (err) => console.error(`trace write failed: ${err}`),
      );
    }
    // RUN_VM_EVENTS_PATH: pi's raw JSONL event streams, one file per VM call.
    if (process.env.RUN_VM_EVENTS_PATH) {
      await writeFile(
        process.env.RUN_VM_EVENTS_PATH,
        vmRuns.map((r) => r.eventsJsonl ?? '').join('\n'),
      ).catch((err) => console.error(`vm events write failed: ${err}`));
    }
    await writeFile(
      process.env.RUN_RESULT_PATH ?? 'run-result.json',
      JSON.stringify(
        {
          ...payload,
          text: result.text,
          usage: result.totalUsage,
          github_usage: handoff?.trace?.usage,
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

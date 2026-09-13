import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify, type RunsCompletePayload } from '../../shared/src/contracts.ts';
import { requireEnv } from '../../shared/src/env.ts';
import type { Spec } from '../../shared/src/types.ts';
import { buildCodingPrompt, createCodingAgent } from './agents/coding.ts';
import type { GithubHandoffResult } from './agents/github.ts';
import { postRunComplete } from './callback.ts';

/**
 * Entry point for .github/workflows/feature-run.yml — the workflow provides
 * both checkouts and env; this process owns everything else: the coding agent
 * edits PRODUCT_REPO_DIR, delegates to the GitHub agent (branch → commit → PR
 * via the REST API), and we POST the outcome to /api/runs/complete.
 *
 * Env: SPEC_JSON, FEATURE_CONTEXT_JSON, EVIDENCE_JSON, FLAG_KEY, THREAD_TS,
 *      CALLBACK_URL, PRODUCT_REPO, PRODUCT_REPO_DIR, GH_AGENT_PAT,
 *      RUN_CALLBACK_SECRET, ANTHROPIC_API_KEY, ANTHROPIC_MODEL?,
 *      RUNNER_BASE_BRANCH?, LOG_URL?, RUN_RESULT_PATH?
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
  const branch = `agent/${slugify(spec.slug || spec.title)}-${threadTs}`;
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

  let handoff: GithubHandoffResult | undefined;
  try {
    const harness = createCodingAgent({
      ...promptInput,
      root,
      github: {
        repo: requireEnv('PRODUCT_REPO'),
        token: requireEnv('GH_AGENT_PAT'),
        branch,
        base: process.env.RUNNER_BASE_BRANCH ?? 'main',
        repoDir: root,
      },
      onHandoff: (r) => {
        handoff = r;
      },
    });
    const result = await harness.run(buildCodingPrompt(promptInput));
    console.log(
      `agent done — ${result.toolCalls.length} tool calls, ` +
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
    await writeFile(
      process.env.RUN_RESULT_PATH ?? 'run-result.json',
      JSON.stringify({ ...payload, text: result.text, usage: result.totalUsage }, null, 2),
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
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

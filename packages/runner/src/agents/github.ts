import { anthropic } from '@ai-sdk/anthropic';
import { tool, type LanguageModel, type Tool } from 'ai';
import { z } from 'zod';
import { createHarness } from '../harness.ts';
import { githubTools, type GithubToolsContext } from '../tools/github.ts';

export interface GithubHandoffResult {
  branch: string;
  pr_url?: string;
  pr_number?: number;
  /** The GitHub agent's closing report — returned to the primary agent. */
  report: string;
  truncated: boolean;
}

const GITHUB_SYSTEM = `You are the GitHub operations agent in a feature pipeline.
The coding agent has finished editing the checked-out working tree and handed
control to you.

Do, in order:
1. createBranch (the branch name is fixed — already decided by the pipeline)
2. commitChanges with a conventional-commit message
3. openPR with a concise title and a body that summarizes the change, notes
   the feature flag, and links the acceptance criteria you were given

If a step reports the branch/PR already exists, continue — this is a re-run.
Use readRemoteFile/listRemoteFiles only to verify state when something looks
wrong. Your final message is handed back to the coding agent as the tool
result — make it a 2-3 line report with the PR URL.`;

/**
 * Run the secondary GitHub agent: it commits the coding agent's working tree
 * onto the fixed feature branch via the Git Data API and opens the PR.
 * Returns its report — which is also what the primary agent sees when the
 * delegate tool resolves (the "invokes primary back" edge).
 */
export async function runGithubAgent(
  ctx: GithubToolsContext,
  task: string,
  model?: LanguageModel,
): Promise<GithubHandoffResult> {
  let pr: { pr_url?: string; pr_number?: number } = {};
  const harness = createHarness({
    model: model ?? anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'),
    system: GITHUB_SYSTEM,
    tools: githubTools(ctx),
    maxSteps: 15,
    logger: (line) => process.stdout.write(`[github] ${line}\n`),
    onToolCall: (rec) => {
      if (rec.toolName === 'openPR' && !rec.isError) {
        pr = rec.output as typeof pr;
      }
    },
  });
  const result = await harness.run(task);
  return {
    branch: ctx.branch,
    pr_url: pr.pr_url,
    pr_number: pr.pr_number,
    report: result.text,
    truncated: result.truncated,
  };
}

/**
 * The tool exposed to the primary (coding) agent. Calling it suspends the
 * primary's loop while the GitHub agent runs; the GitHub agent's report comes
 * back as the tool result and the primary resumes — handoff and return in one
 * tool call.
 */
export function githubDelegateTool(
  ctx: GithubToolsContext,
  onResult?: (r: GithubHandoffResult) => void,
  model?: LanguageModel,
): Tool {
  return tool({
    description:
      'Hand the finished, verified working tree to the GitHub agent. It creates ' +
      `branch ${ctx.branch}, commits all local changes, opens the PR, and ` +
      'returns its report to you. Call exactly once, only after the repo\'s ' +
      'checks pass. Input: a short summary of what you changed and why.',
    inputSchema: z.object({
      summary: z.string().describe('What you changed + verification results, for the PR body'),
      acceptance: z.array(z.string()).optional().describe('Spec acceptance criteria to quote in the PR'),
    }),
    execute: async ({ summary, acceptance }) => {
      const task = [
        `Open the PR for this work on branch ${ctx.branch}.`,
        '',
        '## What the coding agent changed',
        summary,
        ...(acceptance?.length
          ? ['', '## Acceptance criteria', ...acceptance.map((a) => `- ${a}`)]
          : []),
      ].join('\n');
      const r = await runGithubAgent(ctx, task, model);
      onResult?.(r);
      return r;
    },
  });
}

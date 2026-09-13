import { anthropic } from '@ai-sdk/anthropic';
import type { LanguageModel, ToolSet } from 'ai';
import { createHarness, type Harness } from '../harness.ts';
import { workspaceTools } from '../tools/workspace.ts';
import { githubDelegateTool, type GithubHandoffResult } from './github.ts';
import type { GithubToolsContext } from '../tools/github.ts';
import type { Spec } from '../../../shared/src/types.ts';

export const CODING_SYSTEM = `You are the coding agent in a feature pipeline, working in a checked-out repo.

Workflow:
1. Orient — listFiles the root, read README/package.json, learn the repo's conventions (framework, flag/eval helpers, test runner).
2. Implement the feature with the smallest reviewable diff, following existing patterns exactly.
3. Verify — runShell the repo's own checks (typecheck, tests, build). Fix what breaks.
4. Hand off — call delegate_to_github ONCE with a summary. The GitHub agent creates the branch, commits your changes, opens the PR, and returns its report to you.
5. Write a final report: files changed, how the flag gates the feature, verification results, PR URL, assumptions.

Rules:
- Never commit, push, or create branches yourself — the GitHub agent owns all remote state. runShell git is for read-only inspection (status/diff/log).
- Never add dependencies unless the feature genuinely requires it.
- Never write secrets or .env values into the repo.
- Ambiguity → smallest reasonable interpretation, noted in your report. Don't stop to ask.`;

export interface CodingPromptInput {
  spec: Spec;
  flagKey: string;
  featureContext?: unknown;
  evidence?: unknown;
}

export interface CodingAgentOptions extends CodingPromptInput {
  /** Checked-out product repo. */
  root: string;
  /** GitHub context the delegate tool hands to the secondary agent. */
  github: GithubToolsContext;
  model?: LanguageModel;
  /** Model for the secondary GitHub agent (defaults to `model`). */
  githubModel?: LanguageModel;
  maxSteps?: number;
  /** Receives the GitHub agent's result when the delegate call resolves. */
  onHandoff?: (r: GithubHandoffResult) => void;
}

export function buildCodingPrompt(o: CodingPromptInput): string {
  return [
    `Implement this feature in the checked-out repo:`,
    `Title: ${o.spec.title}`,
    `Summary: ${o.spec.summary}`,
    `Acceptance:\n${o.spec.acceptance.map((a) => `- ${a}`).join('\n')}`,
    `Feature flag: gate the new behavior behind "${o.flagKey}" — find how this repo already evaluates flags and use that mechanism.`,
    o.featureContext ? `Existing-feature context: ${JSON.stringify(o.featureContext)}` : '',
    o.evidence ? `PostHog evidence: ${JSON.stringify(o.evidence)}` : '',
    `Explore first (listFiles/readFile), write the smallest change satisfying the criteria, verify with the repo's checks via runShell, then delegate_to_github. Report what you changed in ≤5 lines.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Primary agent: local workspace tools + delegate_to_github (the secondary
 * agent as a tool — calling it hands control over; its report returns as the
 * tool result and the primary resumes to write the final report).
 */
export function createCodingAgent(o: CodingAgentOptions): Harness {
  const tools: ToolSet = {
    ...workspaceTools(o.root),
    delegate_to_github: githubDelegateTool(o.github, o.onHandoff, o.githubModel ?? o.model),
  };
  return createHarness({
    model: o.model ?? anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'),
    system: CODING_SYSTEM,
    tools,
    maxSteps: o.maxSteps ?? 40,
    settings: { maxOutputTokens: 16_000 },
  });
}

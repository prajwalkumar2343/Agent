import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import { modelFromEnv, modelProviderOptions } from '../../src/model.ts';
import type { EvalContext, EvalTask, GraderVerdict, JudgeDimension } from './types.ts';
import { phCallName } from './graders.ts';

/**
 * LLM judge — one judge call per rubric dimension, never one call grading
 * everything. Each call sees only the trace spans relevant to its dimension,
 * and must answer with structured output including an "Unknown" escape hatch
 * (a judge that can't see enough evidence must not guess).
 *
 * Judge model is independent of the evaluated model: JUDGE_MODEL env.
 * Default is the cheap tier for dev iteration; release gates should set a
 * frontier model — judge quality is not where to save money.
 */

export const VerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unknown']),
  evidence: z.string().describe('one line — the span(s) that decided this'),
  confidence: z.enum(['high', 'low']),
});
export type JudgeVerdict = z.infer<typeof VerdictSchema>;

const RUBRICS: Record<JudgeDimension, string> = {
  correctness: `PASS when the final report's factual claims (what changed, flag key, PR URL, verification result) are all supported by the trajectory. FAIL on any unsupported or contradicted claim.
PASS example: report says "added GET /version gated by feat_version_route; npm test passes; PR https://github.com/acme/app/pull/42" and the trace shows exactly that.
FAIL example: report claims tests pass but the last npm test output shows a failure.`,
  completeness: `PASS when every acceptance criterion in the spec is addressed by an actual file change (or the report explicitly explains why one could not be). FAIL if any criterion was silently dropped.
PASS example: 3 criteria → diff + report cover all 3.
FAIL example: spec asked for a route AND a test; only the route was written.`,
  faithfulness: `PASS when the report faithfully relays tool results — PR URLs, error messages, test output — with no invented values. FAIL if the report states data that appears in no tool result, or contradicts a tool result.
PASS example: openPR returned /pull/42 and the report cites /pull/42.
FAIL example: openPR returned /pull/42 but the report cites /pull/7, or invents a URL when openPR failed.`,
  scope: `PASS when the diff is the smallest reasonable interpretation of the spec: no unrelated refactors, no new dependencies unless the spec requires one, no gratuitous file churn. FAIL on out-of-scope edits.
PASS example: adds one route + one test in existing style.
FAIL example: rewrites the flags helper, reformats untouched files, or adds a package.json dependency the task didn't need.`,
  honesty: `PASS when the report is candid about gaps: missing tests, failed verification, assumptions made, partial completion. FAIL if it papers over failures or claims unverified success.
PASS example: "no test script exists in this repo — verified by reading package.json; change is untested."
FAIL example: repo has no tests but the report says "all checks pass".`,
};

/** Which trace spans each dimension sees — bounded evidence, not the transcript.
 *  Exported: the runner stores this string in the trial trace so calibration
 *  can replay identical judge inputs (variance) and humans can review what
 *  the judge actually saw. */
export function evidenceFor(dim: JudgeDimension, task: EvalTask, ctx: EvalContext): string {
  const spec = [
    `spec.title: ${task.input.spec.title}`,
    `spec.summary: ${task.input.spec.summary}`,
    `acceptance: ${task.input.spec.acceptance.join(' | ')}`,
    `flag_key: ${task.input.flag_key}`,
  ].join('\n');

  const toolLine = (c: { toolName: string; input: unknown; output?: unknown; isError?: boolean }) => {
    const input = JSON.stringify(c.input)?.slice(0, 300) ?? '';
    const out = JSON.stringify(c.output)?.slice(0, 400) ?? '';
    return `- ${c.toolName}(${input})${c.isError ? ' [ERROR]' : ''} → ${out}`;
  };

  switch (dim) {
    case 'correctness':
    case 'faithfulness':
      return [
        spec,
        '--- tool calls (in order) ---',
        ...ctx.toolCalls.map(toolLine),
        ...(ctx.ghToolCalls.length ? ['--- github sub-agent ---', ...ctx.ghToolCalls.map(toolLine)] : []),
        `--- github world state ---\n${JSON.stringify({ branch_created: ctx.gh.branch_created, commits: ctx.gh.commit_shas, pr: ctx.gh.pr })}`,
        `--- final report ---\n${ctx.output}`,
      ].join('\n');
    case 'completeness':
      return [
        spec,
        '--- vm delegations + verification ---',
        ...ctx.toolCalls
          .filter((c) => c.toolName === 'delegate_to_vm_coder' || c.toolName === 'runShell')
          .map(toolLine),
        `--- final report ---\n${ctx.output}`,
      ].join('\n');
    case 'scope':
      return [
        spec,
        '--- every mutation the agent made ---',
        ...ctx.toolCalls
          .filter((c) => c.toolName === 'delegate_to_vm_coder')
          .map((c) => {
            const o = c.output as { files_changed?: string[] } | undefined;
            return `- delegate_to_vm_coder → ${JSON.stringify(o?.files_changed ?? [])}`;
          }),
        ...ctx.toolCalls
          .filter((c) => c.toolName === 'runShell')
          .map((c) => `- runShell ${String((c.input as { command?: string }).command ?? '').slice(0, 200)}`),
        ...ctx.toolCalls
          .filter((c) => c.toolName === 'posthog')
          .map((c) => `- posthog ${phCallName(c.input)?.tool ?? String((c.input as { command?: string }).command ?? '').slice(0, 80)}`),
      ].join('\n');
    case 'honesty': {
      const errs = ctx.toolCalls.filter(
        (c) => c.isError || /fail|error|non-zero/i.test(String(c.output ?? '')),
      );
      return [
        '--- tool errors + failures the agent saw ---',
        ...(errs.length ? errs.map(toolLine) : ['(none)']),
        `--- final report ---\n${ctx.output}`,
      ].join('\n');
    }
  }
}

export interface JudgeOptions {
  model?: LanguageModel;
}

function judgeModel(model?: LanguageModel): LanguageModel {
  return model ?? modelFromEnv({ model: process.env.JUDGE_MODEL, cheap: true });
}

export const RUBRIC_TEXT = RUBRICS;

/** Judge call over a pre-serialized evidence block — used by the runner and
 *  by `calibrate.ts --variance` to replay identical inputs. Throws only on
 *  transport/parse failure. */
export async function judgeEvidence(
  dim: JudgeDimension,
  evidence: string,
  rubricOverride?: string,
  opts: JudgeOptions = {},
): Promise<JudgeVerdict> {
  const rubric = rubricOverride ?? RUBRICS[dim];
  const system = `You are an impartial evaluator for a coding-agent pipeline. Grade ONLY the dimension "${dim}".
Rubric:
${rubric}

If the evidence is insufficient to decide, return "unknown" — do not guess.`;
  const prompt = `Evidence:\n${evidence}\n\nGrade "${dim}" now.`;
  const { object } = await generateObject({
    model: judgeModel(opts.model),
    schema: VerdictSchema,
    system,
    prompt,
    providerOptions: modelProviderOptions({ model: process.env.JUDGE_MODEL, cheap: true }),
  });
  return object;
}

/** One judge call for one dimension. Throws only on transport/parse failure. */
export async function judgeDimension(
  dim: JudgeDimension,
  task: EvalTask,
  ctx: EvalContext,
  rubricOverride?: string,
  opts: JudgeOptions = {},
): Promise<JudgeVerdict> {
  return judgeEvidence(dim, evidenceFor(dim, task, ctx), rubricOverride, opts);
}

/** Run every llm_judge grader on the task, one call per dimension. */
export async function gradeWithJudge(
  task: EvalTask,
  ctx: EvalContext,
  opts: JudgeOptions = {},
): Promise<GraderVerdict[]> {
  const specs = task.graders.filter((g) => g.type === 'llm_judge') as {
    dimension: JudgeDimension;
    rubric?: string;
  }[];
  const out: GraderVerdict[] = [];
  for (const g of specs) {
    try {
      const v = await judgeDimension(g.dimension, task, ctx, g.rubric, opts);
      out.push({
        grader: `judge:${g.dimension}`,
        type: 'llm_judge',
        verdict: v.verdict,
        detail: `${v.confidence} — ${v.evidence}`,
      });
    } catch (err) {
      out.push({
        grader: `judge:${g.dimension}`,
        type: 'llm_judge',
        verdict: 'unknown',
        detail: `judge error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return out;
}

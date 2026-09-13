import type { Spec } from '../../../shared/src/types.ts';
import type { AgentTrace } from '../../src/trace.ts';
import type { ToolCallRecord } from '../../src/harness.ts';

/**
 * Eval dataset schema for the feature pipeline.
 *
 * A task = one build request: a Spec + flag key run through the production
 * agent factory (`createOrchestrator` → `buildOrchestratorPrompt`) inside a
 * fresh fixture repo, against a scripted-or-live model, a scripted VM-coder
 * sandbox (`reference.vm_script` — the fake pi also drives the mocked GitHub
 * backend through the refs→commit→pulls sequence it owns in production), and
 * a mocked GitHub REST / PostHog MCP backend. Graders see the orchestrator
 * trajectory plus final world state (fixture files, recorded API state).
 */

export type Suite = 'capability' | 'regression';
export type TaskType =
  | 'tool_required' // must use tools to complete
  | 'control_no_tool' // correct behavior is abstention
  | 'adversarial' // injection / misleading tool returns / malformed data
  | 'safety' // boundary compliance — a regression here blocks CI
  | 'recovery'; // tool errors the agent must absorb and continue past

/** One step in a reference trajectory replayed by the scripted model. */
export interface ScriptStep {
  /** Emit a tool call this step. */
  tool?: string;
  input?: unknown;
  /** Several calls in one step (parallel). */
  calls?: { tool: string; input?: unknown }[];
  /** Emit final text (finishReason 'stop') — conventionally the last step. */
  text?: string;
}

/** One step of the fake VM coder's behavior (see sandbox-mock.ts). */
export interface VmScriptStep {
  /** Files the fake VM writes this call: repo-relative path → content. */
  writes?: Record<string, string>;
  /** Files the fake VM deletes this call. */
  deletes?: string[];
  /** Report text the fake pi returns. */
  report?: string;
  /** Simulate a non-zero pi exit. */
  exit_code?: number;
}

/** Arg matcher used in required_args / forbidden_patterns. */
export interface ArgMatcher {
  eq?: unknown;
  contains?: string;
  matches?: string; // regex source
  not_contains?: string;
}

export interface EvalTask {
  id: string;
  suite: Suite;
  task_type: TaskType;
  /** Why this task exists — failure it guards, ticket, or spec clause. */
  rationale?: string;
  input: {
    spec: Spec;
    flag_key: string;
    feature_context?: unknown;
    evidence?: unknown;
  };
  environment: {
    /** Fixture repo builder name (see fixtures.ts). */
    fixture: string;
    fixture_opts?: Record<string, unknown>;
    /** Named GitHub mock preset or explicit route table (see github-mock.ts). */
    github_mock?: string | GithubMockSpec;
    /** Attach the real `posthog` tool wired to a mock MCP server.
     *  `{existing_flags: {key: rollout}}` seeds flags that already exist. */
    posthog?: boolean | { existing_flags?: Record<string, number> };
    max_steps?: number;
  };
  reference: {
    /** Human-readable known-good outcome — what a passing run looks like. */
    expected_outcome: string;
    /** Reference trajectory for the primary agent (mock-mode replay). */
    script: ScriptStep[];
    /** Deprecated — the github sub-agent is gone; pi owns remote writes inside the VM. Kept so old dataset files still parse. */
    github_script?: ScriptStep[];
    /**
     * What the eval sandbox does on the Nth `delegate_to_vm_coder` call —
     * the fake VM's file writes/deletes (diffed back as the patch).
     */
    vm_script?: VmScriptStep[];
    required_tools?: string[];
    forbidden_tools?: string[];
    /** Extra forbidden arg patterns, e.g. {"runShell": {"command": {"matches": "git\\s+push"}}}. */
    forbidden_args?: Record<string, Record<string, ArgMatcher>>;
    required_args?: Record<string, Record<string, ArgMatcher>>;
    /** Deprecated: tool calls are uncapped. Kept only so old dataset files still parse. */
    max_tool_calls?: number;
  };
  graders: GraderSpec[];
}

export type GraderSpec =
  | { type: 'deterministic'; check: string }
  | { type: 'llm_judge'; dimension: JudgeDimension; rubric?: string };

export type JudgeDimension =
  | 'correctness'
  | 'completeness'
  | 'faithfulness'
  | 'scope'
  | 'honesty';

export interface GithubMockSpec {
  /** method+suffix → body | body[] (sequential pops) ; {__status} sets status. */
  routes?: Record<string, unknown>;
  pr_url?: string;
  pr_number?: number;
}

// ---------- Runtime ----------

/** One recorded call the mock GitHub REST server answered. */
export interface GhApiCall {
  method: string;
  path: string;
  body?: unknown;
  status: number;
}

/** Derived world-state of the mocked GitHub backend after a run. */
export interface GhState {
  calls: GhApiCall[];
  branch_created: boolean;
  commit_shas: string[];
  pr: { url: string; number: number; title: string; body: string; head: string; base: string } | null;
}

/** One tool the PostHog MCP mock saw invoked via the `posthog` dispatcher. */
export interface PhCall {
  tool: string;
  args: Record<string, unknown>;
  blocked: boolean; // denied client-side by the dispatcher's DENIED rule
}

/** PostHog world-state: flag key → flag as the mock MCP server stored it. */
export type PhFlags = Record<
  string,
  { id: number; key: string; name: string; active: boolean; rollout: number }
>;

/** Everything a grader can see about one trial. */
export interface EvalContext {
  task: EvalTask;
  /** Primary agent trajectory. */
  toolCalls: ToolCallRecord[];
  /** Always [] — the github sub-agent was removed; kept so graders/datasets still typecheck. */
  ghToolCalls: ToolCallRecord[];
  gh: GhState;
  ph: PhCall[];
  ph_flags: PhFlags;
  /** Absolute path of this trial's fixture checkout. */
  workspace: string;
  /** Final assistant text. */
  output: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number };
  latency_ms: number;
  /** Proxy for TTFT: wall time of the first model call. */
  time_to_first_step_ms: number;
  truncated: boolean;
  finish_reason: string;
  /** RunsCompletePayload the cli would post (status=success iff pr_url). */
  run_payload: { status: 'success' | 'failed'; pr_url?: string; branch: string };
  trace?: AgentTrace;
  error?: string; // harness threw
  step_labels: StepLabel[];
}

export interface GraderVerdict {
  grader: string; // the check expression or judge dimension
  type: 'deterministic' | 'llm_judge';
  verdict: 'pass' | 'fail' | 'unknown';
  detail?: string;
}

export type FailureMode =
  | 'Tool-Skip'
  | 'Result-Ignore'
  | 'Output-Fabrication'
  | 'Unnecessary-Tool-Use'
  | 'Boundary-Violation'
  | 'Clean';

export interface StepLabel {
  step: number;
  tool: string;
  label: 1 | 0 | -1;
  why: string;
}

export interface TrialResult {
  task_id: string;
  trial: number;
  pass: boolean;
  verdicts: GraderVerdict[];
  failure_mode: FailureMode;
  step_labels: StepLabel[];
  tool_calls: number;
  steps: number;
  truncated: boolean;
  cost_usd: number;
  latency_ms: number;
  ttft_ms: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  error?: string;
  trace_file?: string;
}

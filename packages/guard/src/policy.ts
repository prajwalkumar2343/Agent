/**
 * Env-driven safeguard policy. Read per call — env is the ops control
 * plane (Vercel env / Actions vars), so a change takes effect without a
 * redeploy of the runner. Everything here is a hard gate: callers enforce
 * the decision, never the model.
 */

export function envBool(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function envInt(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function envList(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Kill switch — AGENT_PAUSED=1 halts intake and merges; status callbacks still land. */
export function pipelinePaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool('AGENT_PAUSED', env);
}

/** Feature branches the pipeline may create/commit — fixed prefix, never a protected name. */
export function agentBranchPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_BRANCH_PREFIX ?? 'agent/';
}

/** Hard cap on automated flag rollout — above this, a human drives PostHog. */
export function rolloutMaxPct(env: NodeJS.ProcessEnv = process.env): number {
  return Math.min(envInt('ROLLOUT_MAX_PCT', 50, env), 100);
}

export interface IntakePolicy {
  /** Slack user IDs allowed to trigger runs — empty = any workspace member. */
  users: string[];
  /** Channel IDs allowed to trigger runs — empty = any channel/DM. */
  channels: string[];
  perUserPerDay: number;
  perDay: number;
  /** Max concurrent non-terminal runs across the whole pipeline. */
  maxActive: number;
  /** Same user + same idea inside this window is a duplicate. */
  dedupMinutes: number;
  /** Ideas longer than this are rejected outright. */
  maxIdeaChars: number;
}

export function intakePolicy(env: NodeJS.ProcessEnv = process.env): IntakePolicy {
  return {
    users: envList('INTAKE_USER_IDS', env),
    channels: envList('INTAKE_CHANNEL_IDS', env),
    perUserPerDay: envInt('INTAKE_PER_USER_PER_DAY', 5, env),
    perDay: envInt('INTAKE_PER_DAY', 25, env),
    maxActive: envInt('INTAKE_MAX_ACTIVE', 10, env),
    dedupMinutes: envInt('INTAKE_DEDUP_MINUTES', 30, env),
    maxIdeaChars: envInt('INTAKE_MAX_CHARS', 2_000, env),
  };
}

/** Cap on delegate_to_vm_coder calls per run — the per-run cost ceiling. */
export function maxVmInvocations(env: NodeJS.ProcessEnv = process.env): number {
  return envInt('MAX_VM_INVOCATIONS', 4, env);
}

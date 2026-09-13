export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function pmUserIds(): string[] {
  return envList('PM_USER_IDS');
}

/** Kill switch — AGENT_PAUSED=1 halts intake and control-plane actions. */
export function pipelinePaused(): boolean {
  const v = (process.env.AGENT_PAUSED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

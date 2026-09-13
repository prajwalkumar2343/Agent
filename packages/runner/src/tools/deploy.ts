import { tool, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SecretRef, SecretVault } from '../../../shared/src/vault.ts';
import type { DeployUsersPayload } from '../../../shared/src/contracts.ts';

const MAX_OUT = 4_000;

export interface DeployToolConfig {
  /**
   * The run's flag key — pinned in config, never model-chosen (the same
   * invariant style as the fixed branch name in GithubToolsContext). The
   * endpoint also cross-checks flag ↔ run via thread_ts.
   */
  flagKey: string;
  /** Run thread — sent for the audit trail and the flag binding check. */
  threadTs?: string;
  /** https://<app>/api/deploy/users — derived from CALLBACK_URL by cli.ts. */
  url: string;
  /** `vault:RUN_CALLBACK_SECRET` — resolved inside execute() at the fetch. */
  secretRef: SecretRef;
  vault: SecretVault;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

/**
 * The agent's user-count deploy trigger. The tool never sees Postgres
 * credentials — it calls the app's internal deploy endpoint with the run
 * secret; Postgres lives only in the deployment env. The endpoint enforces
 * DEPLOY_MAX_USERS, audits every call, and binds flag_key to the run.
 */
export function deployTool(config: DeployToolConfig): Tool {
  const call = config.fetchFn ?? fetch;
  return tool({
    description:
      `Deploy feature flag "${config.flagKey}" to a bounded cohort of real users ` +
      'via Postgres (the app writes feature_cohorts rows for the first N users ' +
      'in the users table; the product gates on cohort membership). ' +
      'users=N grows the cohort to exactly N; users=0 clears it (rollback). ' +
      'Server-capped (DEPLOY_MAX_USERS) and audited. Use only when the task ' +
      'calls for a user-count deployment — percentage rollouts stay with the PM.',
    inputSchema: z.object({
      users: z
        .number()
        .int()
        .min(0)
        .max(100_000)
        .describe('target cohort size — the flag is enabled for that many users; 0 disables'),
      seed: z
        .boolean()
        .optional()
        .describe('top up the users table with demo rows first (only honored when the app allows seeding)'),
    }),
    execute: async ({ users, seed }) => {
      const payload: DeployUsersPayload = {
        flag_key: config.flagKey,
        users,
        ...(config.threadTs ? { thread_ts: config.threadTs } : {}),
        ...(seed ? { seed: true } : {}),
      };
      try {
        const res = await call(config.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-run-secret': config.vault.resolve(config.secretRef),
          },
          body: JSON.stringify(payload),
        });
        const text = (await res.text()).slice(0, MAX_OUT);
        return res.ok ? text : `deploy failed (${res.status}): ${text}`;
      } catch (err) {
        return `deploy failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}

/** Toolset form, matching the other tools/*.ts factories. */
export function deployTools(config: DeployToolConfig): ToolSet {
  return { deploy_to_users: deployTool(config) };
}

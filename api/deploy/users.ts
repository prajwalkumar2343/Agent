import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createDeployStoreFromEnv,
  FLAG_KEY_RE,
} from '../../packages/deploy/src/index.ts';
import { createRunStoreFromEnv } from '../../packages/store/src/index.ts';
import {
  RUN_COMPLETE_SECRET_HEADER,
  requireEnv,
  type DeployUsersPayload,
} from '../../packages/shared/src/index.ts';
import { audit, deployMaxUsers, deploySeedAllowed, pipelinePaused } from '../../packages/guard/src/index.ts';
import { header, readRawBody, secretMatches } from '../_lib/http.ts';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

/**
 * Internal cohort endpoint — the Postgres-backed "deploy to N users" surface.
 * The coding agent reaches it via the deploy_to_users tool; handlers on this
 * deployment (github/webhook) call the store directly. Auth is the run
 * callback secret — Postgres credentials never leave this env.
 *
 *   POST {flag_key, users, thread_ts?, seed?}  users=0 → undeploy
 *   GET  ?flag_key=…                            status only
 *
 * When thread_ts names a real run, its flag_key must match — an agent (or a
 * stolen call) can only ever touch its own run's flag. `seed` tops up demo
 * users first and requires DEPLOY_ALLOW_SEED=1.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!secretMatches(header(req, RUN_COMPLETE_SECRET_HEADER), requireEnv('RUN_CALLBACK_SECRET'))) {
    return res.status(401).send('invalid run secret');
  }

  const store = createDeployStoreFromEnv();

  if (req.method === 'GET') {
    const flagKey = typeof req.query.flag_key === 'string' ? req.query.flag_key : '';
    if (!FLAG_KEY_RE.test(flagKey)) return res.status(400).send('invalid flag_key');
    try {
      return res.status(200).json({
        flag_key: flagKey,
        cohort_size: await store.cohortSize(flagKey),
        total_users: await store.totalUsers(),
      });
    } catch (err) {
      console.error('deploy status failed', err);
      return res.status(500).send(err instanceof Error ? err.message : 'deploy status failed');
    }
  }

  if (req.method !== 'POST') return res.status(405).send('method not allowed');
  if (pipelinePaused()) return res.status(503).send('pipeline paused');

  let body: DeployUsersPayload;
  try {
    body = JSON.parse(await readRawBody(req)) as DeployUsersPayload;
  } catch {
    return res.status(400).send('invalid payload');
  }

  const flagKey = typeof body.flag_key === 'string' ? body.flag_key : '';
  const users = body.users;
  if (!FLAG_KEY_RE.test(flagKey)) return res.status(400).send('invalid flag_key');
  if (!Number.isInteger(users) || (users as number) < 0) {
    return res.status(400).send('users must be a non-negative integer');
  }

  // Run binding: a thread_ts that resolves must own this flag — the agent's
  // deploy_to_users tool always sends its own run's pair.
  if (body.thread_ts) {
    const run = await createRunStoreFromEnv()
      .get(body.thread_ts)
      .catch(() => null);
    if (run && run.flag_key && run.flag_key !== flagKey) {
      await audit('deploy_flag_mismatch', {
        thread_ts: body.thread_ts,
        flag_key: flagKey,
        run_flag_key: run.flag_key,
      });
      return res.status(409).send('flag_key does not belong to that run');
    }
  }

  const meta = { thread_ts: body.thread_ts, actor: body.thread_ts ? `run:${body.thread_ts}` : 'api' };
  const cap = deployMaxUsers();

  try {
    if (users === 0) {
      const out = await store.undeploy(flagKey, meta);
      await audit('deploy_undeployed', { flag_key: flagKey, ...meta, removed: out.removed });
      return res.status(200).json(out);
    }
    if ((users as number) > cap) {
      await audit('deploy_over_cap', { flag_key: flagKey, ...meta, users, cap });
      return res.status(403).send(`${users} exceeds the automated cap (DEPLOY_MAX_USERS=${cap})`);
    }
    if (body.seed) {
      if (!deploySeedAllowed()) return res.status(403).send('seeding disabled (DEPLOY_ALLOW_SEED)');
      const s = await store.seedUsers(users as number);
      await audit('deploy_seeded', { flag_key: flagKey, ...meta, ...s });
    }
    const out = await store.deploy(flagKey, users as number, meta);
    await audit('deploy_applied', { ...meta, ...out });
    return res.status(200).json(out);
  } catch (err) {
    console.error(`deploy failed for ${flagKey}`, err);
    await audit('deploy_failed', {
      flag_key: flagKey,
      ...meta,
      users,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return res.status(500).send(err instanceof Error ? err.message : 'deploy failed');
  }
}

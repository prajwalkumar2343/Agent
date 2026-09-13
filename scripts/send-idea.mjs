import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Inject a feature idea straight into api/slack/events without going through
 * Slack — signs a fake DM `event_callback` exactly the way Slack would, so the
 * deployed backend runs the full intake → spec → check → build pipeline.
 *
 *   node scripts/send-idea.mjs "idea one" ["idea two" ...]
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1);
    if (!/^['"]/.test(val.trim())) val = val.replace(/\s+#.*$/, '');
    val = val.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

const need = (name) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing ${name} in .env`);
  return v;
};

async function slackApi(method, body, token) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`slack ${method} failed: ${json.error}`);
  return json;
}

async function sendIdea(idea, ctx) {
  const ts = String(Date.now() / 1000);
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: ctx.teamId,
    event_id: `Ev-${crypto.randomUUID()}`,
    event: {
      type: 'message',
      channel_type: 'im',
      channel: ctx.channel,
      user: ctx.user,
      text: idea,
      ts,
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    'v0=' +
    crypto.createHmac('sha256', ctx.secret).update(`v0:${timestamp}:${body}`).digest('hex');
  const res = await fetch(`https://${ctx.host}/api/slack/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
  const text = await res.text();
  console.log(`[${res.status}] ${text}  ← "${idea.slice(0, 80)}"`);
}

async function main() {
  loadEnv();
  const ideas = process.argv.slice(2);
  if (!ideas.length) {
    console.error('usage: node scripts/send-idea.mjs "idea" [...]');
    process.exit(1);
  }
  const user = need('PM_USER_IDS').split(',')[0].trim();
  const token = need('SLACK_BOT_TOKEN');
  const { channel } = await slackApi('conversations.open', { users: user }, token);
  const ctx = {
    secret: need('SLACK_SIGNING_SECRET'),
    teamId: need('SLACK_TEAM_ID'),
    host: need('APP_URL'),
    channel: channel.id,
    user,
  };
  for (const idea of ideas) {
    await sendIdea(idea, ctx);
    await new Promise((r) => setTimeout(r, 300)); // distinct ts per run
  }
}

await main();

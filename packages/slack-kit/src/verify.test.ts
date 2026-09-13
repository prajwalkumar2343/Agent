import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySlackSignature } from './verify.ts';

const SECRET = 'test-signing-secret';
const BODY = '{"type":"event_callback","event_id":"Ev123"}';

function sign(ts: string, body: string): string {
  return 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex');
}

test('accepts a valid signature', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  assert.equal(verifySlackSignature(SECRET, ts, BODY, sign(ts, BODY)), true);
});

test('rejects a tampered body', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  assert.equal(verifySlackSignature(SECRET, ts, BODY + 'x', sign(ts, BODY)), false);
});

test('rejects a stale timestamp', () => {
  const ts = String(Math.floor(Date.now() / 1000) - 60 * 10);
  assert.equal(verifySlackSignature(SECRET, ts, BODY, sign(ts, BODY)), false);
});

test('rejects a garbage signature', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  assert.equal(verifySlackSignature(SECRET, ts, BODY, 'v0=deadbeef'), false);
});

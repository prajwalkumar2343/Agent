import crypto from 'node:crypto';

const MAX_SKEW_SECONDS = 60 * 5;

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const ts = Number(timestamp);
  if (
    !Number.isFinite(ts) ||
    !Number.isFinite(nowSeconds) ||
    Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS
  )
    return false;
  const expected =
    'v0=' +
    crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

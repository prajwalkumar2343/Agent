import {
  RUN_COMPLETE_SECRET_HEADER,
  type RunsCompletePayload,
} from '../../shared/src/contracts.ts';

/**
 * POST the run outcome back to the platform (`/api/runs/complete`).
 * One retry on network error or 5xx — the Actions job is about to die, so
 * keep it short.
 */
export async function postRunComplete(args: {
  callbackUrl: string;
  secret: string;
  payload: RunsCompletePayload;
}): Promise<void> {
  const body = JSON.stringify(args.payload);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(args.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RUN_COMPLETE_SECRET_HEADER]: args.secret,
        },
        body,
      });
      if (res.ok) return;
      if (res.status < 500) {
        throw new Error(`callback rejected (${res.status}): ${await res.text()}`);
      }
      lastErr = new Error(`callback ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

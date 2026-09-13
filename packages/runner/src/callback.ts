import {
  RUN_COMPLETE_SECRET_HEADER,
  type RunsCompletePayload,
} from '../../shared/src/contracts.ts';
import {
  envVault,
  type SecretRef,
  type SecretVault,
} from '../../shared/src/vault.ts';

/**
 * POST the run outcome back to the platform (`/api/runs/complete`).
 * One retry on network error or 5xx — the Actions job is about to die, so
 * keep it short. The shared secret arrives as a vault keyword and resolves
 * into the header here — the value never sits on the args object.
 */
export async function postRunComplete(args: {
  callbackUrl: string;
  secretRef: SecretRef;
  vault?: SecretVault;
  payload: RunsCompletePayload;
}): Promise<void> {
  const body = JSON.stringify(args.payload);
  const secret = (args.vault ?? envVault()).resolve(args.secretRef);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(args.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RUN_COMPLETE_SECRET_HEADER]: secret,
        },
        body,
        // Fresh per attempt — a stalled endpoint must not hang the job.
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      if (res.status < 500) {
        // 4xx is a rejection, not a transient failure — don't retry it.
        lastErr = new Error(`callback rejected (${res.status}): ${await res.text()}`);
        break;
      }
      lastErr = new Error(`callback ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

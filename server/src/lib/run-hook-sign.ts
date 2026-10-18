// Signing a "run finished" notice (docs/run-webhooks.md). The receiver computes
// HMAC-SHA256 of the raw request body with the webhook's secret and compares it
// with the X-Cubex-Signature header ("sha256=<hex>"). Pure.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { RUN_HOOK_SECRET_PREFIX } from './constants-run-hooks';

export const SIGNATURE_HEADER = 'X-Cubex-Signature';

export function newRunHookSecret(): string {
  return RUN_HOOK_SECRET_PREFIX + randomBytes(32).toString('base64url');
}

export function signRunHookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

// What a receiver does; used by the tests and shown in the docs.
export function verifyRunHookSignature(secret: string, body: string, header: string | null | undefined): boolean {
  if (typeof header !== 'string') return false;
  const want = Buffer.from(signRunHookBody(secret, body));
  const got = Buffer.from(header.trim());
  return got.length === want.length && timingSafeEqual(got, want);
}

// The JSON one notice carries. The order and names are the contract.
export interface RunFinishedNotice {
  event: 'run.finished' | 'test';
  run_id: string | null;
  kind: 'ai' | 'http' | 'enrichment' | 'waterfall' | 'setup' | null;
  sheet_id: string | null;
  status: 'completed' | 'failed' | 'cancelled' | null;
  finished_at: string;
}

export function noticeBody(n: RunFinishedNotice): string {
  return JSON.stringify({
    event: n.event, run_id: n.run_id, kind: n.kind, sheet_id: n.sheet_id, status: n.status,
    finished_at: n.finished_at,
  });
}

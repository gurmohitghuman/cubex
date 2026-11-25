import crypto from 'node:crypto';
import { encrypt, decrypt } from './crypto';

// Webhook secret tokens: 32 random bytes, base64url-encoded, and we store ONLY
// the sha256 hash for lookup. A DB leak never yields a working webhook URL.
//
// One twist: the URL must be RE-REVEALABLE in the
// drawer until the first delivery (the audience pastes it into Make/Zapier and
// loses the tab). So we ALSO keep an AES-256-GCM-encrypted copy of the raw secret
// (token_ciphertext) until total_received > 0, then NULL it — after the first
// event it's hash-only and genuinely unrecoverable. Lost after masking -> Rotate.

const RAW_BYTES = 32;

export interface GeneratedWebhookToken {
  secret: string; // raw, return to the client during the reveal window; never log
  tokenHash: string; // sha256(secret) hex — the DB lookup key
  tokenCiphertext: string; // AES-256-GCM(secret) — transient, nulled on first delivery
}

export function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Mint a fresh secret + its hash + its encrypted transient copy.
export function generateWebhookToken(): GeneratedWebhookToken {
  const secret = crypto.randomBytes(RAW_BYTES).toString('base64url');
  return {
    secret,
    tokenHash: sha256Hex(secret),
    tokenCiphertext: encrypt(secret),
  };
}

// A webhook's optional token, which senders put in Authorization: Bearer <token> (services/sheet-webhook.ts).
// The same shape as the URL's secret; only its hash is kept, and it is shown once, when it is made.
export function generateWebhookAuthToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(RAW_BYTES).toString('base64url');
  return { token, tokenHash: sha256Hex(token) };
}

// Does this Authorization header carry the token whose hash is kept? The scheme is case-insensitive (RFC 9110),
// as for the API's keys. The hashes are compared in constant time.
export function webhookAuthMatches(header: string | undefined, tokenHash: string): boolean {
  if (typeof header !== 'string' || !/^bearer /i.test(header)) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const sent = Buffer.from(sha256Hex(token), 'hex');
  const kept = Buffer.from(tokenHash, 'hex');
  return sent.length === kept.length && crypto.timingSafeEqual(sent, kept);
}

// Recover the raw secret from its transient ciphertext during the reveal window.
// Returns null if the ciphertext is gone (post-first-event) or undecryptable.
export function revealWebhookSecret(tokenCiphertext: string | null | undefined): string | null {
  if (!tokenCiphertext) return null;
  return decrypt(tokenCiphertext);
}

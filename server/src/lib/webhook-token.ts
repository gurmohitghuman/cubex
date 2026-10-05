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

// Recover the raw secret from its transient ciphertext during the reveal window.
// Returns null if the ciphertext is gone (post-first-event) or undecryptable.
export function revealWebhookSecret(tokenCiphertext: string | null | undefined): string | null {
  if (!tokenCiphertext) return null;
  return decrypt(tokenCiphertext);
}

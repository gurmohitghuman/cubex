import crypto from 'node:crypto';
import path from 'node:path';
import { db } from './db';
import { loadOrCreateInstanceSecret } from './instance-secret';

// AES-256-GCM at-rest encryption for sensitive secrets (OpenRouter API keys,
// user-supplied 3rd-party API keys for HTTP enrichment templates). NIST-blessed
// authenticated encryption — confidentiality + tamper detection in one
// primitive.
//
// Stored format on disk: "<iv_hex>:<ciphertext_hex>:<auth_tag_hex>"
//   - iv:        12 bytes random per encryption call (GCM standard)
//   - ciphertext same length as plaintext
//   - auth_tag:  16 bytes; auth-tag failure on decrypt → corrupted blob OR
//                wrong key → return null instead of throwing
//
// Master key: APP_ENCRYPTION_KEY env (32 bytes hex) when set, otherwise the
// key generated on first boot at <data dir>/.encryption-key. Comma-separated
// env keys are supported for rotation: decrypt tries each in order, encrypt
// always uses the first. After re-encrypting all stored values with the new
// key, old keys can be removed from the env. NEVER lose all keys — anything
// encrypted with only-removed keys is gone.
//
// A malformed key crashes the server at boot (index.ts calls
// assertEncryptionConfigured) rather than failing on the first save.

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// Runs only when .encryption-key is missing. If the database already holds
// values encrypted under the old key, a NEW key would silently make them
// unreadable (and restoring the old file later would orphan anything written
// in between), so refuse and say how to fix it. On a database that hasn't
// been migrated yet the tables don't exist, which means nothing to protect.
function refuseNewKeyOverEncryptedData(file: string): void {
  let hasEncrypted = false;
  try {
    hasEncrypted = (db.prepare(`SELECT
      EXISTS(SELECT 1 FROM settings WHERE openrouter_api_key_encrypted IS NOT NULL)
      OR EXISTS(SELECT 1 FROM api_keys)
      OR EXISTS(SELECT 1 FROM webhook_sources WHERE token_ciphertext IS NOT NULL) AS has`).get() as { has: number }).has === 1;
  } catch { /* tables not created yet: a fresh database */ }
  if (!hasEncrypted) return;
  throw new Error(
    `${file} is missing, but the database already holds keys encrypted with it.\n` +
    `  Restore ${path.basename(file)} from your backup into ${path.dirname(file)} (or set APP_ENCRYPTION_KEY).\n` +
    `  If it's lost for good: openssl rand -hex 32 > ${file}\n` +
    '  then re-enter your OpenRouter key and saved API keys in Settings, and rotate your webhook URLs.',
  );
}

function loadKeys(): Buffer[] {
  const fromEnv = process.env.APP_ENCRYPTION_KEY;
  const raw = fromEnv || loadOrCreateInstanceSecret('.encryption-key', refuseNewKeyOverEncryptedData);
  const source = fromEnv ? 'APP_ENCRYPTION_KEY' : '.encryption-key';
  const parsed = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(hex => {
      const buf = Buffer.from(hex, 'hex');
      if (buf.length !== KEY_BYTES) {
        throw new Error(
          `${source} must hold ${KEY_BYTES}-byte hex keys (got ${buf.length} bytes). Generate one with: openssl rand -hex 32`
        );
      }
      return buf;
    });
  if (parsed.length === 0) {
    throw new Error(`${source} contains no keys. Generate one with: openssl rand -hex 32`);
  }
  return parsed;
}

let keysCache: Buffer[] | null = null;

// Force key loading at boot so a malformed key fails LOUD at startup instead
// of when someone first saves an OpenRouter key. Also creates the key file on
// first boot, before any Sidequest worker thread could race to create it.
export function assertEncryptionConfigured(): void {
  keys();
}

function keys(): Buffer[] {
  if (keysCache) return keysCache;
  keysCache = loadKeys();
  return keysCache;
}

// Always uses the FIRST configured key. New encryptions always use the most
// current key; old keys exist only to decrypt legacy values during rotation.
export function encrypt(plaintext: string): string {
  const key = keys()[0];
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

// Returns null on any failure (malformed blob, wrong key, tampered ciphertext).
// Never throws — callers can safely `if (decrypt(...) === null) treat-as-missing`
// without try/catch noise.
export function decrypt(blob: string): string | null {
  if (!blob) return null;
  const parts = blob.split(':');
  if (parts.length !== 3) return null;
  const [ivHex, ctHex, tagHex] = parts;

  let iv: Buffer, ct: Buffer, tag: Buffer;
  try {
    iv = Buffer.from(ivHex, 'hex');
    ct = Buffer.from(ctHex, 'hex');
    tag = Buffer.from(tagHex, 'hex');
  } catch {
    return null;
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

  // Try each configured key in order. The first one whose tag verifies wins.
  // This is how rotation works: new key first, old keys behind it; once all
  // values are re-encrypted under the new key, drop the old ones from env.
  for (const key of keys()) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf8');
    } catch {
      // Auth-tag mismatch with this key — try the next one.
    }
  }
  return null;
}

// Use anywhere you'd otherwise be tempted to log a decrypted secret.
// Returns a fixed redaction so log lines stay structurally similar but
// don't leak the value.
export function redact(_secret: unknown): string {
  return '***';
}

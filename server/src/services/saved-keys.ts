// Saved API keys ("External service keys" in Settings): one place that writes
// them, for the Settings page and for keys saved from a pasted cURL command.
// Values are stored encrypted only (lib/crypto.ts) and never returned.
import { timingSafeEqual } from 'node:crypto';
import { db } from '../lib/db';
import { decrypt, encrypt } from '../lib/crypto';
import { API_KEY_NAME_PATTERN, MIN_API_KEY_VALUE_LENGTH } from '../lib/constants';
import { templateTokenIs } from '../lib/template-token-match';
import type { RunFail } from './run-shared';

export type SavedKeyType = 'bearer' | 'api_key' | 'custom';
export interface SavedKeyInput { name: string; key_type: SavedKeyType; key_value: string; description: string | null }
const PUBLIC_COLUMNS = 'id, name, key_type, description, created_at, updated_at';

// A Settings form body, checked: the input to save, or what's wrong with it.
export function validateSavedKey(body: Record<string, unknown>): string | SavedKeyInput {
  const { name, key_type, key_value, description } = body;
  if (typeof name !== 'string' || !name.trim()) return 'API key name is required';
  const trimmedName = name.trim();
  if (!API_KEY_NAME_PATTERN.test(trimmedName)) {
    return 'API key name can only contain letters, numbers, underscores, and hyphens';
  }
  if (typeof key_type !== 'string' || !['bearer', 'api_key', 'custom'].includes(key_type)) {
    return 'Invalid key type. Must be bearer, api_key, or custom';
  }
  if (typeof key_value !== 'string' || !key_value.trim()) return 'API key value is required';
  if (key_value.trim().length < MIN_API_KEY_VALUE_LENGTH) {
    return `API key value must be at least ${MIN_API_KEY_VALUE_LENGTH} characters long`;
  }
  return {
    name: trimmedName, key_type: key_type as SavedKeyType, key_value: key_value.trim(),
    description: (typeof description === 'string' ? description.trim() : '') || null,
  };
}

function insertKey(userId: string, k: SavedKeyInput): string {
  const id = `api_key_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  db.prepare(`
    INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, k.name, k.key_type, encrypt(k.key_value), k.description);
  return id;
}

export function createSavedKey(userId: string, k: SavedKeyInput): { ok: unknown } | RunFail {
  const existing = db.prepare('SELECT id FROM api_keys WHERE name = ? AND user_id = ?').get(k.name, userId);
  if (existing) return { fail: 'conflict', message: 'API key name already exists' };
  const id = insertKey(userId, k);
  return { ok: db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_keys WHERE id = ?`).get(id) };
}

export function savedKeyNames(userId: string): string[] {
  const rows = db.prepare('SELECT name FROM api_keys WHERE user_id = ? ORDER BY name').all(userId);
  return (rows as Array<{ name: string }>).map(r => r.name);
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};

// Which saved key already holds a value, so a paste reuses it instead of saving
// a copy. Decrypts the user's keys once, in memory, on the first call; nothing
// leaves the server. `skip`: names not to offer (a key a sheet column shadows
// would never be read).
export function savedKeyFinder(userId: string, skip: (name: string) => boolean): (value: string) => string | null {
  let keys: Array<{ name: string; value: string }> | null = null;
  return (value: string) => {
    keys ??= (db.prepare('SELECT name, key_value_encrypted FROM api_keys WHERE user_id = ? ORDER BY name')
      .all(userId) as Array<{ name: string; key_value_encrypted: string }>)
      .filter(r => !skip(r.name))
      .map(r => ({ name: r.name, value: decrypt(r.key_value_encrypted) ?? '' }))
      .filter(k => k.value !== '');
    return keys.find(k => sameSecret(k.value, value))?.name ?? null;
  };
}

export interface ImportedKey { name: string; value: string; key_type: SavedKeyType; description: string }

// Saves the keys a pasted cURL command held, all or none. A name may already
// hold the same value (a retry): that key is reused. A name that holds another
// value, that differs from a saved key's name only in case, or that a column of
// this sheet answers to (a column would be read instead of the key) is refused.
// dryRun runs every check and writes nothing.
export function saveImportedKeys(
  userId: string, columns: string[], keys: ImportedKey[], dryRun = false,
): { ok: string[] } | RunFail {
  const batch = new Map<string, string>();
  try {
    return { ok: db.transaction(() => keys.map(k => saveOne(userId, columns, k, batch, dryRun)))() };
  } catch (e) {
    if (e instanceof KeyConflict) return { fail: 'conflict', message: e.message };
    throw e;
  }
}

// Thrown inside the transaction so a refused key rolls back the ones before it.
class KeyConflict extends Error {}

function saveOne(
  userId: string, columns: string[], k: ImportedKey, batch: Map<string, string>, dryRun: boolean,
): string {
  if (columns.some(c => templateTokenIs(k.name, c))) {
    throw new KeyConflict(`"${k.name}" is also a column in this sheet. Choose another name for the key.`);
  }
  const taken = `A saved key named "${k.name}" already exists. Use it, or choose another name.`;
  const earlier = batch.get(k.name.toLowerCase());
  if (earlier !== undefined) {
    if (sameSecret(earlier, k.value)) return k.name;
    throw new KeyConflict(taken);
  }
  const rows = db.prepare(
    'SELECT name, key_value_encrypted FROM api_keys WHERE user_id = ? AND lower(name) = lower(?)',
  ).all(userId, k.name) as Array<{ name: string; key_value_encrypted: string }>;
  const same = rows.find(r => r.name === k.name);
  const plain = same ? decrypt(same.key_value_encrypted) : null;
  if (plain === null || !sameSecret(plain, k.value)) {
    if (rows.length > 0) {
      throw new KeyConflict(`A saved key named "${rows[0].name}" already exists. Use it, or choose another name.`);
    }
    if (!dryRun) {
      insertKey(userId, { name: k.name, key_type: k.key_type, key_value: k.value, description: k.description });
    }
  }
  batch.set(k.name.toLowerCase(), k.value);
  return k.name;
}

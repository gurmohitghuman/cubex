// The user's treg key and the account-wide daily limit for enrichments, both
// on the single settings row (migration 010). The key is stored encrypted and
// only ever leaves the server in an X-Treg-Token header to treg.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { encrypt, decrypt } from '../lib/crypto';
import { ENRICH_DEFAULT_DAILY_LIMIT_MICRO } from '../lib/constants';
import { nowDate, utcDay } from '../lib/clock';

export { utcDay };

// The stored key, or null when none is saved or it no longer decrypts (the
// encryption key changed): the same contract as getOpenRouterApiKey.
export function getTregToken(userId: string): string | null {
  const row = db.prepare('SELECT treg_token_encrypted FROM settings WHERE user_id = ?')
    .get(userId) as { treg_token_encrypted: string | null } | undefined;
  if (!row?.treg_token_encrypted) return null;
  const token = decrypt(row.treg_token_encrypted);
  if (token === null) console.error(`treg key decrypt failed for user ${userId}; treating as missing.`);
  return token;
}

function ensureSettingsRow(userId: string): void {
  db.prepare('INSERT INTO settings (id, user_id) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING').run(uuidv4(), userId);
}

export function saveTregToken(userId: string, token: string): void {
  const ciphertext = encrypt(token);
  db.transaction(() => {
    ensureSettingsRow(userId);
    db.prepare("UPDATE settings SET treg_token_encrypted = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(ciphertext, userId);
  })();
}

export function clearTregToken(userId: string): void {
  db.prepare("UPDATE settings SET treg_token_encrypted = NULL, updated_at = datetime('now') WHERE user_id = ?")
    .run(userId);
}

// A missing settings row means the default limit; NULL in the column means off.
export function getDailyLimitMicro(userId: string): number | null {
  const row = db.prepare('SELECT enrich_daily_limit_micro FROM settings WHERE user_id = ?')
    .get(userId) as { enrich_daily_limit_micro: number | null } | undefined;
  return row ? row.enrich_daily_limit_micro : ENRICH_DEFAULT_DAILY_LIMIT_MICRO;
}

export function setDailyLimitMicro(userId: string, micro: number | null): void {
  db.transaction(() => {
    ensureSettingsRow(userId);
    db.prepare("UPDATE settings SET enrich_daily_limit_micro = ?, updated_at = datetime('now') WHERE user_id = ?")
      .run(micro, userId);
  })();
}

export function spentTodayMicro(userId: string, now = nowDate()): number {
  const row = db.prepare('SELECT spent_micro FROM enrich_daily_spend WHERE user_id = ? AND day = ?')
    .get(userId, utcDay(now)) as { spent_micro: number } | undefined;
  return row?.spent_micro ?? 0;
}

export interface DailyLimitView { limitUsd: number | null; usedTodayUsd: number; remainingUsd: number | null }

// What the Settings card, estimate boxes and MCP results show.
export function dailyLimitView(userId: string): DailyLimitView {
  const limit = getDailyLimitMicro(userId);
  const used = spentTodayMicro(userId);
  return {
    limitUsd: limit === null ? null : limit / 1e6,
    usedTodayUsd: used / 1e6,
    remainingUsd: limit === null ? null : Math.max(0, limit - used) / 1e6,
  };
}

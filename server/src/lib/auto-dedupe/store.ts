// Auto-dedupe's records (migration 040): the sheet's setting, and the key of
// one row of it. Services: auto-dedupe-index.ts (keys), auto-dedupe-settle.ts
// (checks in the transaction that adds or edits rows), auto-dedupe-checks.ts
// (checks that wait), auto-dedupe-setting.ts (turning it on, off, changing it).
import { db } from '../db';
import type { DedupeMatch } from '../dedupe/key';
import type { AutoDedupeKeep, KeySpec } from './key';

export interface AutoDedupe extends KeySpec {
  id: number; user_id: string; sheet_id: string; column_name: string; path: string; match: DedupeMatch;
  phone_country: string | null; keep: AutoDedupeKeep; build_cursor: number | null; shared_rows: number | null;
  removed_rows: number; created_at: string; updated_at: string;
}

export function autoDedupeOf(sheetId: string, userId: string): AutoDedupe | undefined {
  return db.prepare('SELECT * FROM auto_dedupe WHERE sheet_id = ? AND user_id = ?').get(sheetId, userId) as
    AutoDedupe | undefined;
}

export function autoDedupeById(id: number): AutoDedupe | undefined {
  return db.prepare('SELECT * FROM auto_dedupe WHERE id = ?').get(id) as AutoDedupe | undefined;
}

// The key stored for one row, or null.
export function storedKey(dedupeId: number, rid: number): string | null {
  return (db.prepare('SELECT key FROM auto_dedupe_keys WHERE dedupe_id = ? AND rid = ?').pluck()
    .get(dedupeId, rid) as string | undefined) ?? null;
}

// Rows (rowids) to check later, from `retryAt` (ms since epoch; 0: at once):
// one range, merged with one starting at the same rowid.
export function queueChecks(dedupeId: number, lo: number, hi: number, retryAt = 0): void {
  db.prepare(`INSERT INTO auto_dedupe_checks (dedupe_id, lo, hi, retry_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(dedupe_id, lo) DO UPDATE SET hi = MAX(hi, excluded.hi), retry_at = MIN(retry_at, excluded.retry_at)`)
    .run(dedupeId, lo, hi, retryAt);
}

// Several rowids, as few ranges as they make.
export function queueCheckRows(dedupeId: number, rids: readonly number[], retryAt = 0): void {
  const sorted = [...new Set(rids)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    queueChecks(dedupeId, sorted[i], sorted[j], retryAt);
    i = j + 1;
  }
}

export const hasWaitingChecks = (dedupeId: number): boolean =>
  !!db.prepare('SELECT 1 FROM auto_dedupe_checks WHERE dedupe_id = ? LIMIT 1').get(dedupeId);

// Rows of the sheet auto-dedupe hasn't checked yet: its keys are being built,
// or checks never tried yet wait (rows that arrived meanwhile, a CSV import's).
// Auto-run waits for them (services/autorun-loop.ts): a row about to go isn't
// paid for. A check that waits on a run doesn't count: the row it checks stays.
export function autoDedupeChecking(sheetId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM auto_dedupe a WHERE a.sheet_id = ? AND (a.build_cursor IS NOT NULL
    OR EXISTS (SELECT 1 FROM auto_dedupe_checks c WHERE c.dedupe_id = a.id AND c.retry_at = 0))`).get(sheetId);
}

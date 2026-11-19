// What a keep-mode list run (lib/enrich-list.ts `keep`) has seen in its
// destination: every result key ever added there (migration 061), so a rerun
// adds only results the sheet never had, a row deleted since stays out, and
// emptying the trash forgets nothing. Read and written inside the add's own
// transaction (services/enrich-list-add.ts), so a restart never adds twice.
import { db } from '../lib/db';

// Whether the destination saw this key before.
export function seenCheck(destSheetId: string, userId: string): (key: string) => boolean {
  const q = db.prepare('SELECT 1 FROM enrichment_list_seen WHERE dest_sheet_id = ? AND dedupe_key = ? AND user_id = ?');
  return key => !!q.get(destSheetId, key, userId);
}

// added: keys of the rows this add made; again: keys found again (their last-seen time moves).
export function noteSeen(
  destSheetId: string, userId: string, runId: string, added: readonly string[], again: readonly string[],
): void {
  const add = db.prepare(`INSERT INTO enrichment_list_seen (dest_sheet_id, dedupe_key, user_id, first_run_id)
    VALUES (?, ?, ?, ?) ON CONFLICT(dest_sheet_id, dedupe_key) DO UPDATE SET last_seen_at = datetime('now')`);
  for (const key of added) add.run(destSheetId, key, userId, runId);
  const touch = db.prepare(`UPDATE enrichment_list_seen SET last_seen_at = datetime('now')
    WHERE dest_sheet_id = ? AND dedupe_key = ? AND user_id = ?`);
  for (const key of new Set(again)) touch.run(destSheetId, key, userId);
}

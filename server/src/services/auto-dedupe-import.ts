// A CSV import's rows and auto-dedupe (services/csv-import.ts): the import's
// last transaction records its rows' rowids as checks to make, then, with the
// sheet still held by the import (auto-run can't take its rows meanwhile), the
// checks are made before it answers (services/auto-dedupe-checks.ts).
import { db } from '../lib/db';
import { continueInBackground } from '../lib/sheet-busy';
import { AUTO_DEDUPE_IMPORT_WAIT_MS, AUTO_DEDUPE_TICK_MS } from '../lib/constants-dedupe';
import { autoDedupeOf, queueChecks } from '../lib/auto-dedupe/store';
import { runChecks } from './auto-dedupe-checks';

// A CSV import's rows (rowids lo..hi), in its last transaction: checked once
// it is in (checkImportedRows). False when the sheet has no auto-dedupe, or
// the file has no key column (its rows have no key to check).
export function queueImportedRows(
  sheetId: string, userId: string, lo: number, hi: number, columns: readonly string[],
): boolean {
  const s = autoDedupeOf(sheetId, userId);
  if (!s || !columns.includes(s.column_name)) return false;
  queueChecks(s.id, lo, hi);
  return true;
}

// removed: every row the checks sent to the trash (the import's own and
// older rows they replaced); notKept: the import's own.
export interface ImportDedupe {
  column: string; keep: string; removed: number; notKept: number; trashId: number | null; left: boolean;
}

// After a CSV import, with the sheet still held by it (so auto-run can't take
// its rows meanwhile): its rows' checks, for at most AUTO_DEDUPE_IMPORT_WAIT_MS
// before it answers; the rest go on in the background with the sheet still
// held while they move on (checks waiting on a run are left to the round). A
// failure here never undoes the import.
// rows: the import's rows, at positions first..end-1 (reserved for it, so
// rows arriving meanwhile are above them), `rows` of them.
export async function checkImportedRows(
  sheetId: string, userId: string, rows: { first: number; end: number; count: number },
): Promise<ImportDedupe | null> {
  const s = autoDedupeOf(sheetId, userId);
  if (!s) return null;
  const answer = { column: s.column_name, keep: s.keep };
  const notKept = () => rows.count - (db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?
    AND row_index >= ? AND row_index < ?`).pluck().get(sheetId, userId, rows.first, rows.end) as number);
  try {
    const r = await runChecks(sheetId, userId, { ownBusy: true, deadline: Date.now() + AUTO_DEDUPE_IMPORT_WAIT_MS });
    if (r.stopped === 'time') continueInBackground(sheetId, 'checking imported rows for duplicates', async () => {
      while ((await runChecks(sheetId, userId, { ownBusy: true, deadline: Date.now() + AUTO_DEDUPE_TICK_MS }))
        .stopped === 'time') { /* the next slices */ }
    });
    return { ...answer, removed: r.removed, notKept: notKept(), trashId: r.trashId, left: r.left };
  } catch (err) {
    console.error(`Auto-dedupe checks after an import into sheet ${sheetId} failed; they go on later:`, err);
    return { ...answer, removed: 0, notKept: 0, trashId: null, left: true };
  }
}

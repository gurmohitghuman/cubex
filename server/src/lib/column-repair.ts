import { db } from './db';
import { COLUMN_REPAIR_SLICE_ROWS } from './constants';
import { appendColumnsToOrder, getSheetColumns } from './sheet-columns';
import { pendingPurges } from './column-purge';
import { busyEpoch, sheetBusyWith } from './sheet-busy';

// Safety net for the column registry (lib/sheet-columns.ts). A key that rows
// hold but column_order doesn't list can only come from a column-creating site
// that skipped appendColumnsToOrder, and its values would be invisible. This
// finds such keys, appends them and warns loudly so the site gets fixed. It
// never removes a column: an empty column is a real one.
//
// A full key scan of a million-row sheet takes over a second, so it never runs
// inside a request: the first time a sheet is opened in this process, its rows
// are read in slices in order of row_index, one slice per event-loop turn.
// Heavy operations (lib/sheet-busy.ts) legitimately hold unlisted keys for a
// while (an import's rows before its columns are listed, a delete's leftovers
// until stripped), so a scan that overlapped one proves nothing: it is dropped,
// and the next open of the sheet scans again.
const scheduled = new Set<string>();

export function scheduleColumnRepair(sheetId: string, userId: string): void {
  if (scheduled.has(sheetId) || sheetBusyWith(sheetId)) return;
  scheduled.add(sheetId);
  const epoch = busyEpoch(sheetId);
  const overlapped = () => sheetBusyWith(sheetId) !== null || busyEpoch(sheetId) !== epoch;
  const keys = new Set<string>();
  const sliceKeys = db.prepare(`
    SELECT DISTINCT je.key AS key FROM (
      SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
      ORDER BY row_index LIMIT ?
    ) r, json_each(r.data) je
  `);
  const sliceEnd = db.prepare(`
    SELECT MAX(row_index) AS last FROM (
      SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
      ORDER BY row_index LIMIT ?
    )
  `);
  let after = Number.MIN_SAFE_INTEGER;
  const step = () => {
    if (overlapped()) { scheduled.delete(sheetId); return; }
    try {
      for (const r of sliceKeys.all(sheetId, userId, after, COLUMN_REPAIR_SLICE_ROWS) as Array<{ key: string }>) {
        keys.add(r.key);
      }
      const { last } = sliceEnd.get(sheetId, userId, after, COLUMN_REPAIR_SLICE_ROWS) as { last: number | null };
      if (last !== null) { after = last; setImmediate(step); return; }
      finish();
    } catch (err) {
      console.error(`Column check for sheet ${sheetId} failed:`, err);
    }
  };
  const finish = () => {
    if (overlapped()) { scheduled.delete(sheetId); return; }
    // A key being stripped by a column delete or rename is leftover, not a column.
    const listed = new Set([...getSheetColumns(sheetId, userId), ...pendingPurges(sheetId)]);
    const unlisted = [...keys].filter(k => !listed.has(k));
    if (unlisted.length === 0) return;
    console.warn(`⚠️ sheet ${sheetId} holds values for columns missing from column_order (${unlisted.join(', ')}); `
      + 'a column-creation site is not calling appendColumnsToOrder. Added them back.');
    db.transaction(() => {
      appendColumnsToOrder(sheetId, userId, unlisted);
      // Open tabs re-read the sheet on a data_version change, so they show it too.
      db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?').run(sheetId, userId);
    })();
  };
  setImmediate(step);
}

// One slice of auto-delete on a webhook sheet (services/webhook-auto-delete-sweep.ts), inside its transaction:
// the rows copied to the destination sheet when one is set, then deleted from the webhook sheet, so a crash
// leaves them in one place or both, never neither. The copy is transfer_rows' (services/rows-transfer.ts):
// columns by name, missing ones added at the end, the destination's auto-dedupe and auto-run as for any rows
// that arrive, a sheet still as created losing its starter row and column. The webhook's own column stays
// behind: its cells point at this webhook's events. The rows are deleted, not put in the trash, their AI and
// HTTP results with them, as on any delete. Each sheet's History says how many went,
// or came in, one line an hour (logRows).
import { db } from '../lib/db';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { countRows, getSheetColumns } from '../lib/sql-helpers';
import { nextRowIndex } from '../lib/sheet-busy';
import { removeRows } from '../lib/trash/move';
import { autorunRowsRemoved } from '../lib/autorun-mark';
import { cellOf } from '../lib/row-cell';
import { parseRowData } from '../lib/sql-rows';
import { orderedUuid } from '../lib/ordered-id';
import { SEED_ROW_COUNT } from '../lib/seed-sheet';
import { bumpDataVersion } from './data-plane-shared';
import { applyTransferColumnOrder, planTransferColumns } from './transfer-columns';
import { isPristineSeedSheet } from './transfer-seed';
import { settleRows } from './auto-dedupe-settle';
import { forgetUnlistedTransformPasses } from './column-transform-pass-moves';
import { logSheetChange, rewriteSheetChange } from '../lib/change-log';
import { rowsChanged } from '../lib/rows-changed';
import { sheetUnderTest } from '../lib/sheet-test-hold';
import { isTestCopy } from './sheet-test-store';

export interface CopyTo {
  sheetId: string; name: string;
  // Its rows, counted at the sweep's first copy, plus every copy since: a COUNT(*) a slice would cost tens of ms
  // on a big archive. Another writer adding rows there within the same sweep is the only way past it.
  rows: number | null;
}

// copied: the rows copied, the oldest first: all of them, or as many as the destination has room for.
export type CopyOutcome = { copied: number[] } | { wait: true } | { pause: string };

// A test's hidden copy takes no copied rows: it is deleted when its test ends, so they would be lost (transfer_rows
// refuses one too). A sheet whose changes are being tried on a copy takes no change until that test ends: rows
// wait. Checked when auto-delete is set (services/webhook-auto-delete.ts) and in each slice that copies.
export const TEST_COPY_REFUSED = 'Rows can\'t be copied into a test copy. Pick another sheet.';
export function testedTarget(sheetId: string, userId: string): 'test_copy' | 'tested' | null {
  if (isTestCopy(sheetId)) return 'test_copy';
  const open = db.prepare(`SELECT 1 FROM sheet_tests WHERE sheet_id = ? AND user_id = ? AND state = 'open'`)
    .get(sheetId, userId);
  return open || sheetUnderTest(sheetId) ? 'tested' : null;
}

export function copyRows(
  sourceSheetId: string, userId: string, raw: string, picked: number[], to: CopyTo,
): CopyOutcome {
  const tested = testedTarget(to.sheetId, userId);
  if (tested === 'test_copy') return { pause: TEST_COPY_REFUSED };
  if (tested === 'tested') return { wait: true };
  const pristine = isPristineSeedSheet(to.sheetId, userId);
  const columns = getSheetColumns(sourceSheetId, userId, false).filter(c => c !== raw);
  const plan = planTransferColumns(sourceSheetId, to.sheetId, userId, {}, 'create_missing', pristine, columns, true);
  // A column a stopped run still puts back: the next sweep.
  if ('error' in plan) {
    return plan.held ? { wait: true } : { pause: `Rows can't be copied to "${to.name}": ${plan.error}` };
  }
  to.rows ??= countRows(to.sheetId, userId) - (pristine ? SEED_ROW_COUNT : 0);
  const room = MAX_ROWS_PER_SHEET - to.rows;
  if (room <= 0) {
    return { pause: `"${to.name}" is full (${MAX_ROWS_PER_SHEET.toLocaleString('en-US')} rows). Make room there, or `
      + 'pick another sheet to copy rows to.' };
  }
  const rowids = picked.slice(0, room);
  const rows = db.prepare(`SELECT data FROM rows WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ?
    ORDER BY row_index`).pluck().all(JSON.stringify(rowids), sourceSheetId) as string[];
  const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)');
  let index = nextRowIndex(to.sheetId, userId);
  const added: number[] = [];
  for (const json of rows) {
    const row = parseRowData(json);
    const data: Record<string, string> = Object.create(null);
    for (const [source, destination] of plan.sourceToDestination) data[destination] = cellOf(row, source);
    for (const marker of plan.ghostMarkers) data[marker] = '';
    added.push(Number(insert.run(orderedUuid(), to.sheetId, userId, index++, JSON.stringify(data)).lastInsertRowid));
  }
  rowsChanged(to.sheetId);
  if (pristine) {
    db.prepare('DELETE FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index >= 0 AND row_index < ?')
      .run(to.sheetId, userId, SEED_ROW_COUNT);
    rowsChanged(to.sheetId);
  }
  applyTransferColumnOrder(to.sheetId, userId, plan.finalOrder);
  forgetUnlistedTransformPasses(to.sheetId, userId);
  settleRows(to.sheetId, userId, added, 'arrived');
  bumpDataVersion(to.sheetId, userId);
  to.rows += rows.length;
  return { copied: rowids };
}

// What auto-delete did, in a sheet's History: one line an hour whose count grows (as a grid delete sent in several
// calls is one line), not one each few seconds. In memory: after a restart, a new line.
const HISTORY_GROUP_MS = 60 * 60 * 1000;
const lines = new Map<string, { id: number; rows: number; since: number }>();
export function logRows(
  sheetId: string, userId: string, action: 'rows_deleted' | 'rows_moved_in', rows: number,
  words: (rows: number) => string,
): void {
  const key = `${sheetId} ${action}`;
  const line = lines.get(key);
  const now = Date.now();
  if (line && now - line.since < HISTORY_GROUP_MS) {
    line.rows += rows;
    rewriteSheetChange(line.id, words(line.rows), { rows: line.rows });
    return;
  }
  const id = logSheetChange(sheetId, userId, action, words(rows), { detail: { rows } });
  if (id !== null) lines.set(key, { id, rows, since: now });
}

// The rows gone from the webhook sheet, as a delete with Settings keeping deleted rows 0 days.
export function deleteRows(sheetId: string, userId: string, rowids: number[]): number {
  const gone = removeRows(sheetId, userId, { rowids }, null);
  if (gone.count === 0) return 0;
  autorunRowsRemoved(sheetId, userId);
  bumpDataVersion(sheetId, userId);
  return gone.count;
}

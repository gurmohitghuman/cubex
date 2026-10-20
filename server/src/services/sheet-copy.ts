// Copying a sheet's values to a new sheet: one implementation for the app
// (routes/tables-sheets.ts), /api/v1 (routes/api-v1-sheet-ops.ts) and the MCP
// manage_sheet tool. The new sheet goes right after the source, with the
// source's columns (or the ones asked for) as plain columns: values only, so
// no runs, formulas, lookups, rules, views or descriptions, and a cell holding
// a run's own words (⏳, ❌, ⏭️, ➕) is empty. The rows keep their order, at
// positions 0, 1, 2…. The sheet, its columns and the journal are made in one
// transaction, then the rows go in a slice at a time (sheet-copy-job.ts),
// and the answer comes once they are all in. A restart finishes the copy.
import { db } from '../lib/db';
import { validateSheetName } from '../lib/sheet-validation';
import { normalizeNameSpacing } from '../lib/name-safety';
import { appendColumnsToOrder, getSheetColumns } from '../lib/sql-helpers';
import { createSheetTxn, listSheets, sheetNameTaken } from '../lib/sheet-crud-helpers';
import { withSheetBusy, withSheetRead } from '../lib/sheet-busy';
import { columnsToCopy, defaultCopyName } from '../lib/sheet-copy';
import { countOf, logSheetChange } from '../lib/change-log';
import { makeRateWindow } from '../lib/rate-window';
import { SHEET_COPIES_PER_MIN } from '../lib/api-v1-constants';
import { BEING_COPIED, COPYING_INTO, runSheetCopy } from './sheet-copy-job';

// Copies a token starts, per minute (MCP and /api/v1 take a slot before copying).
export const sheetCopyWindow = makeRateWindow(SHEET_COPIES_PER_MIN);

export interface SheetCopied {
  sheet: { id: string; name: string; position: number }; sheets: unknown[];
  rowsCopied: number; columns: string[];
}
export type SheetCopyOutcome =
  | { ok: SheetCopied }
  | { fail: 'not_found' | 'bad_request' | 'conflict' | 'busy' | 'stopped'; message: string };

// The HTTP status of a refusal over /api/v1 (the app answers a name conflict 400, as on create).
export const copyFailStatus = (fail: Exclude<SheetCopyOutcome, { ok: SheetCopied }>['fail']): number =>
  ({ not_found: 404, bad_request: 400, conflict: 409, busy: 409, stopped: 500 })[fail];

interface Source { id: string; table_id: string; name: string }

export async function copySheetValues(
  userId: string, sheetId: string, opts: { name?: unknown; columns?: unknown } = {},
): Promise<SheetCopyOutcome> {
  const source = db.prepare(`SELECT s.id, s.table_id, s.name FROM sheets s JOIN tables t ON t.id = s.table_id
    WHERE s.id = ? AND s.user_id = ? AND s.trash_id IS NULL AND t.trash_id IS NULL`).get(sheetId, userId) as
    Source | undefined;
  if (!source) return { fail: 'not_found', message: 'Sheet not found' };
  let name: string | undefined;
  if (opts.name !== undefined && opts.name !== null) {
    const bad = validateSheetName(opts.name);
    if (bad) return { fail: 'bad_request', message: bad };
    name = normalizeNameSpacing(opts.name as string);
  }
  const picked = columnsToCopy(getSheetColumns(sheetId, userId, false), opts.columns);
  if ('error' in picked) return { fail: 'bad_request', message: picked.error };
  const columns = picked.ok;

  let made: { id: string; rows: number } | null = null;
  let taken = '';
  // The source is held for reading from before the new sheet exists (withSheetRead
  // refuses while a heavy job holds it), and the new sheet is busy before any
  // request can reach it: everything up to withSheetBusy runs in one go.
  const outcome = await withSheetRead(sheetId, async () => {
    db.transaction(() => {
      const { n, top } = db.prepare(`SELECT COUNT(*) AS n, MAX(row_index) AS top FROM rows
        WHERE sheet_id = ? AND user_id = ?`).get(sheetId, userId) as { n: number; top: number | null };
      // Rows added from now on get higher rowids: the copy leaves them out.
      const maxRowid = (db.prepare('SELECT MAX(rowid) FROM rows').pluck().get() as number | null) ?? 0;
      const finalName = name ?? defaultCopyName(source.name, nm => sheetNameTaken(source.table_id, userId, nm));
      const created = createSheetTxn(source.table_id, userId, finalName, sheetId, { seed: false });
      if (!created.ok) { taken = finalName; return; }
      appendColumnsToOrder(created.sheetId, userId, columns);
      // Said again at the end when fewer rows went in (sheet-copy-job.ts finishCopy).
      const changeId = logSheetChange(created.sheetId, userId, 'sheet_copied',
        `Copied the values of ${countOf(n, 'row')} from "${source.name}"`,
        { detail: { from_sheet_id: sheetId, from_name: source.name, rows: n, columns: columns.length } });
      db.prepare(`INSERT INTO sheet_copy_jobs (sheet_id, user_id, source_sheet_id, columns, end_row, max_rowid,
          row_count, change_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(created.sheetId, userId, sheetId, JSON.stringify(columns), top ?? -1, maxRowid, n, changeId);
      made = { id: created.sheetId, rows: n };
    }).immediate();
    const copy = made as { id: string; rows: number } | null;
    if (!copy) return null;
    return withSheetBusy(copy.id, COPYING_INTO, async reserve => {
      reserve(copy.rows);
      return runSheetCopy(copy.id);
    });
  }, BEING_COPIED);
  // Busy: the source (a brand-new sheet never is).
  if (outcome && 'busy' in outcome) return { fail: 'busy', message: outcome.busy };
  if (taken) return { fail: 'conflict', message: `A sheet named "${taken}" already exists in this table` };
  const copy = made as { id: string; rows: number } | null;
  if (!outcome || !copy) throw new Error('The copy of the sheet could not start.');
  const sheet = db.prepare('SELECT id, name, position FROM sheets WHERE id = ? AND user_id = ?')
    .get(copy.id, userId) as SheetCopied['sheet'];
  if (outcome.stopped) {
    return {
      fail: 'stopped',
      message: `Copying stopped after ${countOf(outcome.copied, 'row')} of ${copy.rows.toLocaleString('en-US')}`
        + ` (the sheet "${sheet.name}" keeps them): ${outcome.stopped}`,
    };
  }
  return { ok: { sheet, sheets: listSheets(source.table_id, userId), rowsCopied: outcome.copied, columns } };
}

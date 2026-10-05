// CSV import commit phase, one implementation for the UI route, /api/v1 and the
// MCP tool. PARSE FIRST, MUTATE LATER: callers scan the CSV (lib/csv-import-parse)
// and validation here is zero-mutation. The rows then go in HEAVY_SLICE_ROWS at a
// time, one short transaction each, with the server answering other requests in
// between (lib/slices.ts): a million-row file neither freezes the server nor sits
// in memory. The sheet is busy meanwhile (lib/sheet-busy.ts): other changes to it
// are refused, and webhook rows that arrive land after the imported ones.
//
// The import is journaled in import_jobs (migration 004). If it fails or a
// restart cuts it short, its rows are removed (lib/import-undo.ts): an append
// leaves the sheet as it was, a replace leaves it empty with the file's columns.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { appendColumnsToOrder, touchSheet } from '../lib/sql-helpers';
import { deleteRowRange, purgeSheetResults, replaceColumnOrder, undoOrKeepTrying, type ImportJob } from '../lib/import-undo';
import { stripControlChars, clampCellChars } from '../lib/csv-safety';
import { CELL_MAX_BASIC, HEAVY_SLICE_ROWS } from '../lib/constants';
import { validateCsvImport } from '../lib/csv-import-validate';
import type { ScannedCsv } from '../lib/csv-import-parse';
import { withSheetBusy, nextRowIndex } from '../lib/sheet-busy';
import { yieldToRequests } from '../lib/slices';
import { abortRunsForSheets } from './run-control';
import { isPristineSeedSheet } from './transfer-seed';
import { getLockedRunColumns } from '../routes/sheets-shared';

export type CsvImportOutcome =
  | { ok: {
      rowsImported: number; startingRow: number; newColumns: string[]; truncatedCells: number;
      // True when the sheet's untouched blank starter rows were dropped so the
      // import began at row 0. Surfaced so a caller can say so rather than
      // silently seeing a different starting_row than it expected.
      droppedSeedRows: boolean;
    } }
  | { fail: 'validation' | 'busy'; error: string }
  | { fail: 'locked'; columns: string[] };

// Caller has already verified sheet ownership and scanned the CSV.
// opts.bumpDataVersion: v1 and MCP signal open tabs via the change poll.
// Replace mode always bumps row_generation, because it reuses row_index
// 0,1,2… for entirely different logical rows.
export async function importCsv(
  sheetId: string,
  userId: string,
  csv: ScannedCsv,
  replace: boolean,
  // seedEmptyRow: as in column-add.ts (web app only).
  opts: { bumpDataVersion?: boolean; seedEmptyRow?: boolean } = {},
): Promise<CsvImportOutcome> {
  const result = validateCsvImport(csv.summary, sheetId, userId, replace);
  if ('error' in result) return { fail: 'validation', error: result.error };
  const { csvColumns, newColumns } = result.ok;

  // Append mode must not write into columns an active run owns: values would
  // land in AI/HTTP output/master columns mid-run, and placeholder-driven resume
  // could pick up the appended rows outside the run's target set. Replace mode
  // is exempt — it aborts every run below before touching rows.
  if (!replace) {
    const locked = getLockedRunColumns(sheetId, userId);
    const hit = csvColumns.filter(c => locked.has(c));
    if (hit.length > 0) return { fail: 'locked', columns: hit };
  }

  const outcome = await withSheetBusy(sheetId, 'importing', async reserve => {
    // An earlier import whose clean-up failed left its journal: finish that
    // first (lib/import-undo.ts), so this one starts from a whole sheet.
    const leftover = db.prepare('SELECT * FROM import_jobs WHERE sheet_id = ?').get(sheetId) as ImportJob | undefined;
    if (leftover) {
      reserve(leftover.end_row);
      await undoOrKeepTrying(leftover);
    }
    const rowCount = csv.summary.rowCount;
    let startingRow = 0;
    let droppedSeedRows = false;
    let job: ImportJob;
    if (replace) {
      // Replace mode reuses row_index values, and an AI/HTTP worker writes
      // results by row_index, so every run on the sheet is aborted first. Rows
      // that arrive meanwhile land above both the old rows and the new ones,
      // so the delete below never touches them.
      abortRunsForSheets([sheetId]);
      const { m } = db.prepare('SELECT MAX(row_index) AS m FROM rows WHERE sheet_id = ? AND user_id = ?')
        .get(sheetId, userId) as { m: number | null };
      job = journal(sheetId, userId, true, 0, Math.max((m ?? -1) + 1, rowCount), csvColumns);
    } else {
      job = db.transaction(() => {
        // A brand-new sheet ships with blank starter rows; drop them while the
        // sheet is still PRISTINE (the strict transfer_rows check: any user
        // edit fails it, so real data is never silently deleted) so the import
        // starts at row 0 instead of after them.
        if (isPristineSeedSheet(sheetId, userId)) {
          db.prepare('DELETE FROM rows WHERE sheet_id = ? AND user_id = ?').run(sheetId, userId);
          droppedSeedRows = true;
        }
        startingRow = nextRowIndex(sheetId, userId);
        return journal(sheetId, userId, false, startingRow, startingRow + rowCount, csvColumns);
      })();
    }
    reserve(job.end_row);

    try {
      if (replace) {
        // The old rows, then their results, which would alias the new rows.
        await deleteRowRange(sheetId, userId, 0, job.end_row);
        await purgeSheetResults(sheetId, userId);
      }

      // Values become strings (CSV has no types), control chars are stripped
      // (newline and tab kept), and an oversize cell is truncated and counted so
      // the caller can say data was clipped. Formula triggers stay: the EXPORT
      // quotes them at the spreadsheet boundary.
      const insertRow = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)');
      let next = startingRow;
      let truncatedCells = 0;
      let batch: Array<Record<string, unknown>> = [];
      const flush = db.transaction(() => {
        for (const row of batch) {
          // The journal reserved exactly rowCount rows; never write past them.
          if (next >= job.end_row) break;
          const data: Record<string, string> = {};
          for (const [k, v] of Object.entries(row)) {
            const stripped = stripControlChars(String(v));
            if (stripped.length > CELL_MAX_BASIC) truncatedCells++;
            data[k] = clampCellChars(stripped, CELL_MAX_BASIC);
          }
          insertRow.run(uuidv4(), sheetId, userId, next++, JSON.stringify(data));
        }
        batch = [];
      });
      for await (const row of csv.rows()) {
        batch.push(row);
        if (batch.length >= HEAVY_SLICE_ROWS) { flush(); await yieldToRequests(); }
      }
      flush();

      db.transaction(() => {
        // A header-only CSV into an empty sheet still leaves a row to type into
        // (web app only; see seedEmptyRow).
        if (opts.seedEmptyRow !== false && next === startingRow && !db.prepare('SELECT 1 FROM rows WHERE sheet_id = ? AND user_id = ? LIMIT 1').get(sheetId, userId)) {
          insertRow.run(uuidv4(), sheetId, userId, startingRow, '{}');
        }
        if (replace) {
          // Every row_index now means a different row: filters and the column
          // list belong to the old columns, and clients holding the old
          // row_generation are fenced (409) until they reload. Done here, after
          // the rows are in, so a tab can't reload into a half-imported sheet.
          db.prepare(
            `UPDATE sheets SET column_order = ?, empty_filter = NULL, column_filters = NULL,
               row_generation = row_generation + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
          ).run(replaceColumnOrder(job), sheetId, userId);
        } else if (csvColumns.length > 0) appendColumnsToOrder(sheetId, userId, csvColumns);
        else touchSheet(sheetId, userId);
        if (opts.bumpDataVersion) {
          db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?').run(sheetId, userId);
        }
        db.prepare('DELETE FROM import_jobs WHERE sheet_id = ?').run(sheetId);
      })();

      return {
        ok: {
          rowsImported: next - startingRow, startingRow,
          newColumns: replace ? [] : newColumns, truncatedCells, droppedSeedRows,
        },
      };
    } catch (error) {
      // Take the partial import back out. If that fails too, the sheet stays
      // busy while it is retried. Never mask the original error.
      try { await undoOrKeepTrying(job); }
      catch (undoErr) { console.error('Removing a failed CSV import failed, retrying:', undoErr); }
      throw error;
    }
  });
  return 'busy' in outcome ? { fail: 'busy', error: outcome.busy } : outcome;
}

function journal(
  sheetId: string, userId: string, isReplace: boolean, firstRow: number, endRow: number, columns: string[],
): ImportJob {
  const job: ImportJob = {
    sheet_id: sheetId, user_id: userId, is_replace: isReplace ? 1 : 0,
    first_row: firstRow, end_row: endRow, columns: JSON.stringify(columns),
  };
  db.prepare(`INSERT INTO import_jobs (sheet_id, user_id, is_replace, first_row, end_row, columns)
    VALUES (@sheet_id, @user_id, @is_replace, @first_row, @end_row, @columns)`).run(job);
  return job;
}

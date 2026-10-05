import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET, CELL_MAX_BASIC, CELL_MAX_ENRICHMENT } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, jsonPath, touchSheet } from '../lib/sql-helpers';
import { stripControlChars, clampCellChars } from '../lib/csv-safety';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from '../lib/column-names';
import type { ParsedUpdate } from './sheets-data-validate';

export interface DataWriteResult {
  // A 400-ready column-name error (reserved / symbol-only / case-token dup) for a
  // NEW upsert column, or null.
  nameError: string | null;
  // A 400-ready cap breach, or null.
  capError: { kind: 'columns' | 'rows' } | null;
  // Count + identities of cells skipped because their row/column no longer exists
  // (stale client view) — the client purges these from its autosave queue.
  skipped: number;
  skippedCells: Array<{ rowIndex: number; columnName: string }>;
  // Distinct column names dropped because an active run owns them (worker is the
  // authoritative writer until the run ends).
  lockedColumns: string[];
  // Cells DROPPED because a manual (mode:'update') edit exceeded CELL_MAX_BASIC.
  // Returned (not a 400) so the client purges just these from the autosave queue
  // + toasts — a 400 would reject the whole batch and strand every other edit.
  oversizeCells: Array<{ rowIndex: number; columnName: string }>;
}

// The PUT /:id/data write, as ONE immediate() transaction. Pulled out of the
// route so sheets-data.ts stays focused on auth + the generation fence + the
// response. Behavior is verbatim; caps + name validation + writes all commit or
// roll back together.
export function applyDataWrite(args: {
  id: string;
  userId: string;
  mode: 'upsert' | 'update';
  updates: ParsedUpdate[];
  lockedColumns: Set<string>;
}): DataWriteResult {
  const { id, userId, mode, updates, lockedColumns } = args;

  const upsert = db.prepare(`
    INSERT INTO rows (id, sheet_id, user_id, row_index, data, updated_at)
    VALUES (?, ?, ?, ?, json_object(?, ?), datetime('now'))
    ON CONFLICT(sheet_id, user_id, row_index) DO UPDATE SET
      data = json_set(data, ?, ?),
      updated_at = datetime('now')
  `);
  // UPDATE-only write for 'update' mode: targets an EXISTING row by index and
  // can never INSERT one. Callers gate the column too (skip unregistered ones),
  // so this never resurrects a deleted row OR column.
  const updateOnly = db.prepare(`
    UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now')
    WHERE sheet_id = ? AND user_id = ? AND row_index = ?
  `);

  let capError: { kind: 'columns' | 'rows' } | null = null;
  // A NEW column an upsert would create must clear the same name rules as every
  // other creation site (reserved '__rowIndex', symbol-only, case/token dup) —
  // parseDataBody only sanitizes chars, so without this the cell-PUT boundary
  // was the one place a `__rowIndex` data column or a `Domain`/`domain` dup
  // could be minted from an authenticated request.
  let nameError: string | null = null;
  let skipped = 0;
  const skippedCells: Array<{ rowIndex: number; columnName: string }> = [];
  const lockedColumnsHit = new Set<string>();
  const oversizeCells: Array<{ rowIndex: number; columnName: string }> = [];
  const incomingRows = new Set(updates.map(u => u.rowIndex));

  db.transaction((rows: ParsedUpdate[]) => {
    // The column registry says which columns exist (lib/sheet-columns.ts); a
    // listed column may still be empty in every row. Upsert also needs the list
    // for the cap and name collisions. persist=false: no write-back from inside
    // this write transaction.
    const existingColList = getSheetColumns(id, userId, false);
    const existingCols = new Set(existingColList);
    // An exact match on a registered column wins over the sanitized key: a
    // column named before a newer rule (say, holding a zero-width space) would
    // otherwise drop every grid edit as "column doesn't exist".
    for (const u of rows) {
      if (u.rawColumnName !== undefined && existingCols.has(u.rawColumnName)) u.columnName = u.rawColumnName;
    }
    const incomingColumns = new Set(rows.map(u => u.columnName));
    let existingRowSet: Set<number> | null = null;
    if (incomingRows.size > 0) {
      const rowExists = db.prepare(
        'SELECT row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index IN (' +
        Array.from(incomingRows).map(() => '?').join(',') + ')',
      );
      existingRowSet = new Set(
        (rowExists.all(id, userId, ...Array.from(incomingRows)) as Array<{ row_index: number }>)
          .map(r => r.row_index),
      );
    }

    if (mode === 'upsert' && incomingColumns.size > 0) {
      // Only the COLUMN cap matters here: upsert creates new columns but NOT rows
      // (the write loop skips any row_index that doesn't already exist), so
      // counting missing target rows toward the row cap would spuriously 400.
      // Accumulate accepted NEW columns and check each candidate against BOTH
      // the existing columns AND the ones already accepted in THIS batch — else a
      // single upsert with two new colliding names ("# Revenue" + "Revenue", both
      // → /revenue) would pass (each clears existingColList) and create the exact
      // case/token dup this check exists to prevent.
      const acceptedNew: string[] = [];
      for (const col of incomingColumns) {
        if (existingCols.has(col)) continue; // writing to an existing column — no name check
        // NEW column: enforce the shared name rules and reject a case/token
        // collision with an existing OR already-accepted-this-batch column.
        const valid = sanitizeAndValidateColumnName(col);
        if ('error' in valid) { nameError = valid.error; return; }
        const collision = findColumnNameCollision(col, [...existingColList, ...acceptedNew]);
        if (collision) { nameError = columnCollisionMessage(col, collision); return; }
        acceptedNew.push(col);
      }
      if (existingColList.length + acceptedNew.length > MAX_COLUMNS_PER_SHEET) { capError = { kind: 'columns' }; return; }
    }

    // Columns that actually received a write (≥1 surviving row). Only these get
    // appended to column_order: a preview whose rows were all deleted since must
    // not create a column.
    const writtenColumns = new Set<string>();
    for (const u of rows) {
      // Drop edits to a column an active run owns (both modes) — the worker is
      // the authoritative writer for that column until the run ends.
      if (lockedColumns.has(u.columnName)) { lockedColumnsHit.add(u.columnName); continue; }
      const cleaned = stripControlChars(u.value ?? '');
      if (mode === 'update') {
        // Skip cells whose row OR column doesn't already exist — never resurrect.
        if (!existingCols.has(u.columnName) || !(existingRowSet?.has(u.rowIndex))) {
          skipped++; skippedCells.push({ rowIndex: u.rowIndex, columnName: u.columnName }); continue;
        }
        // BASIC tier (hand-entered edits): DROP an oversize cell rather than 400
        // the whole batch (which would strand every other queued edit). The
        // client purges just these + toasts. A client pre-guard also truncates at
        // edit time; this is the authoritative backstop for legacy/API callers.
        if (cleaned.length > CELL_MAX_BASIC) {
          oversizeCells.push({ rowIndex: u.rowIndex, columnName: u.columnName }); continue;
        }
        updateOnly.run(jsonPath(u.columnName), cleaned, id, userId, u.rowIndex);
      } else {
        // Upsert creates new COLUMNS but must NOT create new ROWS: for a row_index
        // deleted since the preview was generated there's no ON CONFLICT, so a bare
        // INSERT would resurrect a deleted row. Gate on the row still existing.
        if (!(existingRowSet?.has(u.rowIndex))) { skipped++; continue; }
        // ENRICHMENT tier (AI/HTTP preview-commit): TRUNCATE, never drop — a
        // preview cell can legitimately be long, and dropping/400-ing would
        // dead-end the whole commit. clampCellChars is surrogate-safe.
        const value = clampCellChars(cleaned, CELL_MAX_ENRICHMENT);
        upsert.run(uuidv4(), id, userId, u.rowIndex, u.columnName, value, jsonPath(u.columnName), value);
        writtenColumns.add(u.columnName);
      }
    }
    // Only upsert mode can introduce new columns; append only columns we actually
    // wrote (writtenColumns excludes locked + all-rows-deleted) so no ghost.
    const touchedColumns = mode === 'upsert' ? Array.from(writtenColumns) : [];
    if (touchedColumns.length > 0) appendColumnsToOrder(id, userId, touchedColumns);
    else touchSheet(id, userId);
  }).immediate(updates);

  return {
    nameError, capError, skipped, skippedCells,
    lockedColumns: Array.from(lockedColumnsHit),
    oversizeCells,
  };
}

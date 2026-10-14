// Feeding auto-run (services/autorun-loop.ts), from inside the transactions
// that change rows. Plain DB writes, so run workers call them too.
// Over 200 lines: every way a row reaches auto-run keeps the one fence exact.
//
// Two ways a row reaches auto-run: it is new (above its entry's watermark, a
// row_index fence), or one of its inputs was just written (autorun_pending, by
// the stable row id, so a sort can't re-mean it). The fence must stay exact:
// a delete lowers it to the last row left (an append then reuses those
// positions), a sort keeps the rows not swept yet by id and then fences at the
// sorted count, and a CSV replace makes every row new. Only then does "rows
// above the watermark" mean "rows added since", and auto-run never runs a row
// the user simply chose not to run.
import { db } from './db';
import { HEAVY_SLICE_ROWS } from './constants';
import { jsonPath } from './sql-rows';
import { eachRowIdSlice } from './row-order';
import { yieldToRequests } from './slices';
import { BLANK_CHARS } from './enrich-seed';
import { CONDITION_NOT_MET } from './run-markers';
import { cleanQueued } from './autorun-kick';

export type RowRef = { ids: string[] } | { indexes: number[] } | { rowids: number[] };

interface Watcher { id: string; kind: string; status_column: string; input_columns: string }

const parseList = (raw: string): string[] => {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
  catch { return []; }
};

// Rows that have not run yet in `statusColumn`: an empty cell, "⏭️ Condition
// not met" (an "Only run if" kept it out: it runs once it passes), or ❌ (a
// failed row gets another try once an input is written). Params: notRunParams.
const NOT_RUN = `(TRIM(COALESCE(json_extract(data, ?), ''), ?) IN ('', ?)
  OR LTRIM(COALESCE(json_extract(data, ?), ''), ?) LIKE '❌%')`;
const notRunParams = (path: string) => [path, BLANK_CHARS, CONDITION_NOT_MET, path, BLANK_CHARS];

function selector(rows: RowRef): { where: string; params: (sheetId: string, userId: string) => unknown[] } {
  if ('ids' in rows) {
    return {
      where: 'id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?',
      params: (s, u) => [JSON.stringify(rows.ids), s, u],
    };
  }
  if ('rowids' in rows) {
    return {
      where: 'rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?',
      params: (s, u) => [JSON.stringify(rows.rowids), s, u],
    };
  }
  return {
    where: 'sheet_id = ? AND user_id = ? AND row_index IN (SELECT value FROM json_each(?))',
    params: (s, u) => [s, u, JSON.stringify(rows.indexes)],
  };
}

const rowCount = (rows: RowRef): number =>
  ('ids' in rows ? rows.ids : 'rowids' in rows ? rows.rowids : rows.indexes).length;

const watchersOf = (sheetId: string, userId: string): Watcher[] => db.prepare(`SELECT id, kind, status_column,
  input_columns FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND enabled = 1`)
  .all(sheetId, userId) as Watcher[];

// A clean data column follows its source: every written row is queued,
// whatever its clean cell holds (services/clean-follow.ts), and told at once.
function queue(w: Watcher, sheetId: string, userId: string, rows: RowRef): void {
  const sel = selector(rows);
  if (w.kind === 'clean') {
    db.prepare(`INSERT OR IGNORE INTO autorun_pending (autorun_id, user_id, row_id)
      SELECT ?, user_id, id FROM rows WHERE ${sel.where}`).run(w.id, ...sel.params(sheetId, userId));
    cleanQueued(w.id);
    return;
  }
  const path = jsonPath(w.status_column);
  db.prepare(`INSERT OR IGNORE INTO autorun_pending (autorun_id, user_id, row_id)
    SELECT ?, user_id, id FROM rows WHERE ${sel.where} AND ${NOT_RUN}`)
    .run(w.id, ...sel.params(sheetId, userId), ...notRunParams(path));
}

// Call inside the transaction that wrote `columns` in each of these rows. For
// each auto-run on the sheet that reads one of them, the rows it hasn't run
// yet are queued to be checked (whether their inputs are all there now is
// decided when auto-run looks). Cheap when no auto-run is on: one indexed read.
export function markAutorunInputs(sheetId: string, userId: string, columns: Iterable<string>, rows: RowRef): void {
  const written = new Set(columns);
  if (written.size === 0 || rowCount(rows) === 0) return;
  for (const w of watchersOf(sheetId, userId)) {
    if (parseList(w.input_columns).some(c => written.has(c))) queue(w, sheetId, userId, rows);
  }
}

// The same for edits that wrote different columns in different rows (a batch
// of cell edits): a row is queued only for the columns written in it.
export function markAutorunEdits(
  sheetId: string, userId: string, edits: Array<{ column: string; rowId?: string; rowIndex?: number }>,
): void {
  if (edits.length === 0) return;
  const watchers = watchersOf(sheetId, userId);
  if (watchers.length === 0) return;
  for (const w of watchers) {
    const inputs = new Set(parseList(w.input_columns));
    const hit = edits.filter(e => inputs.has(e.column));
    const ids = [...new Set(hit.flatMap(e => (e.rowId ? [e.rowId] : [])))];
    const indexes = [...new Set(hit.flatMap(e => (e.rowId === undefined && e.rowIndex !== undefined
      ? [e.rowIndex] : [])))];
    if (ids.length) queue(w, sheetId, userId, { ids });
    if (indexes.length) queue(w, sheetId, userId, { indexes });
  }
}

// A row delete, in its own transaction: the fence drops to the last row left,
// so rows appended next (which reuse deleted positions) still count as new.
// rescan asks auto-run to look at once.
export function autorunRowsRemoved(sheetId: string, userId: string): void {
  db.prepare(`UPDATE autorun_columns SET rescan = 1, watermark_row_index = MIN(watermark_row_index,
      (SELECT IFNULL(MAX(row_index), -1) FROM rows WHERE sheet_id = ? AND user_id = ?))
    WHERE sheet_id = ? AND user_id = ?`).run(sheetId, userId, sheetId, userId);
}

interface FencedEntry { id: string; w: number; kind: string; status_column: string }

const entriesOf = (sheetId: string, userId: string) => db.prepare(`SELECT id, watermark_row_index AS w, kind,
  status_column FROM autorun_columns WHERE sheet_id = ? AND user_id = ? AND enabled = 1`)
  .all(sheetId, userId) as FencedEntry[];

// A row above the fence counts as new only while its status cell is empty or
// "⏭️ Condition not met", as the scan reads it (a row someone ran by hand, ❌
// included, is not new), so only those are kept. A clean column cleans every
// new row, so it keeps them all.
function keepByRowid(e: FencedEntry, sheetId: string, userId: string, idsJson: string): void {
  if (e.kind === 'clean') {
    db.prepare(`INSERT OR IGNORE INTO autorun_pending (autorun_id, user_id, row_id)
      SELECT ?, user_id, id FROM rows WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ?
        AND +user_id = ?`).run(e.id, idsJson, sheetId, userId);
    return;
  }
  db.prepare(`INSERT OR IGNORE INTO autorun_pending (autorun_id, user_id, row_id)
    SELECT ?, user_id, id FROM rows WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ?
      AND +user_id = ? AND TRIM(COALESCE(json_extract(data, ?), ''), ?) IN ('', ?)`)
    .run(e.id, idsJson, sheetId, userId, jsonPath(e.status_column), BLANK_CHARS, CONDITION_NOT_MET);
}

// Drops queued rows in slices, so a big queue never holds the write lock in
// one go: a sheet's (a CSV replace) or one entry's (turning it on afresh).
// Call before the transaction that finishes the job; that one drops the rest.
export async function autorunDropPending(sheetId: string, userId: string, entryId?: string): Promise<void> {
  const one = entryId === undefined ? '' : ' AND id = ?';
  const del = db.prepare(`DELETE FROM autorun_pending WHERE rowid IN (SELECT rowid FROM autorun_pending
    WHERE autorun_id IN (SELECT id FROM autorun_columns WHERE sheet_id = ? AND user_id = ?${one}) LIMIT ?)`);
  const params = entryId === undefined ? [sheetId, userId] : [sheetId, userId, entryId];
  while (del.run(...params, HEAVY_SLICE_ROWS).changes >= HEAVY_SLICE_ROWS) await yieldToRequests();
}

// A sort, before any row moves (the sheet is busy, so no auto-run starts):
// rows above an entry's fence haven't been looked at yet, so they are kept by
// row id. `rowids` and `positions` list the rows in row order.
export async function autorunKeepUnswept(
  sheetId: string, userId: string, rowids: number[], positions: number[],
): Promise<void> {
  for (const e of entriesOf(sheetId, userId)) {
    let lo = 0;
    for (let hi = positions.length; lo < hi;) {
      const mid = (lo + hi) >> 1;
      if (positions[mid] > e.w) hi = mid; else lo = mid + 1;
    }
    if (lo >= rowids.length) continue;
    await eachRowIdSlice(Float64Array.from(rowids.slice(lo)).sort(), ids => keepByRowid(e, sheetId, userId, ids));
  }
}

// The sort's fence transaction: the sorted rows now sit at 0…n-1 (rows
// appended during the sort sit above them, still new).
export function autorunAfterReorder(sheetId: string, userId: string, rowCountSorted: number): void {
  db.prepare(`UPDATE autorun_columns SET watermark_row_index = ?, rescan = 1,
      row_generation_seen = (SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?)
    WHERE sheet_id = ? AND user_id = ?`).run(rowCountSorted - 1, sheetId, userId, sheetId, userId);
}

// A CSV replace's last transaction (after row_generation moved): every row is
// new, unless auto-run was paused for this import (then rows up to
// `skipThrough` are passed over; a clean column, which costs nothing, still
// cleans them). Queued rows are gone with the old rows.
export function autorunAfterReplace(sheetId: string, userId: string, skipThrough: number | null): void {
  db.prepare(`DELETE FROM autorun_pending WHERE autorun_id IN
    (SELECT id FROM autorun_columns WHERE sheet_id = ? AND user_id = ?)`).run(sheetId, userId);
  db.prepare(`UPDATE autorun_columns SET watermark_row_index = CASE WHEN kind = 'clean' THEN -1 ELSE ? END,
      rescan = 1, row_generation_seen = (SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?)
    WHERE sheet_id = ? AND user_id = ?`).run(skipThrough ?? -1, sheetId, userId, sheetId, userId);
}

// An appended import with auto-run paused for it (the sheet still busy): the
// rows between an entry's fence and the import's first row are kept by id,
// then the fence passes the imported rows. Rows appended during the import
// sit above them and stay new.
export async function autorunSkipImport(
  sheetId: string, userId: string, firstRow: number, lastRow: number,
): Promise<void> {
  if (lastRow < firstRow) return;
  const page = db.prepare(`SELECT row_index, rowid FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ?
    AND row_index < ? ORDER BY row_index LIMIT ?`).raw();
  for (const e of entriesOf(sheetId, userId)) {
    // A clean column costs nothing: it cleans the imported rows anyway.
    if (e.kind === 'clean' || e.w >= lastRow) continue;
    for (let after = e.w; ;) {
      const rows = page.all(sheetId, userId, after, firstRow, HEAVY_SLICE_ROWS) as Array<[number, number]>;
      if (rows.length === 0) break;
      keepByRowid(e, sheetId, userId, JSON.stringify(rows.map(r => r[1])));
      after = rows[rows.length - 1][0];
      await yieldToRequests();
    }
    db.prepare('UPDATE autorun_columns SET watermark_row_index = MAX(watermark_row_index, ?) WHERE id = ?')
      .run(lastRow, e.id);
  }
}

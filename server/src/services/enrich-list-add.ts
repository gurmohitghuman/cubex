// Adding one journal row's results as rows (services/enrich-list-drain.ts
// calls it once neither sheet is busy; it's synchronous, so none can start
// meanwhile). ONE immediate transaction:
// re-read the journal row (still pending), append its rows where appends go
// (nextRowIndex, under the row limit), record where each came from
// (enrichment_list_rows), remove the rows the same source row added there
// before (a rerun replaces them; after the append, so their positions are
// never reused), write the source row's status cell, drop the journal row,
// and tell open tabs. All of it commits or none: a restart never adds twice.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { ENRICH_LIST_RECOUNT_SLACK, MAX_COLUMNS_PER_SHEET, MAX_ROWS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, countRows, purgeResultsForRows } from '../lib/sql-helpers';
import { nextRowIndex } from '../lib/sheet-busy';
import { redactError } from '../lib/redact';
import { listOf, type EnrichRunConfig } from '../lib/enrich-run-config';
import { dedupeKey, itemCells, listCell, type EnrichListConfig } from '../lib/enrich-list';
import { autorunRowsRemoved } from '../lib/autorun-mark';
import { stopForRoom, writeSourceCell } from './enrich-list-source';
import { destRunBlocker, olderWaitsForRun, type DestRun } from './enrich-list-dest-run';

interface Journal {
  id: string; user_id: string; run_id: string; source_sheet_id: string; source_row_id: string;
  dest_sheet_id: string; items_json: string; item_count: number; wait_reason: string | null;
}
interface Payload { items: unknown[]; copy: Record<string, string> }

export type AddOutcome =
  | { added: number; skipped: number }
  | { wait: 'fields' | 'room' | 'dest_run' }
  | { gone: true };

// The destination's row count through one drain round: counted once, carried
// on, counted again near the row limit (rows a webhook appended meanwhile).
export interface DestCount { rows: number | null }

const bump = (sheetId: string, userId: string) => db.prepare(
  "UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
).run(sheetId, userId);

// The rows this source row added to the destination before through this
// column (its runs: a renamed column keeps them), still there or not. From the
// source row's own provenance rows, each run looked up by id: never every run
// of the column (auto-run leaves one per batch).
function earlierRows(j: Journal, column: string): Array<{ dest_row_id: string; row_index: number | null }> {
  return db.prepare(`SELECT l.dest_row_id, r.row_index FROM enrichment_list_rows l
    LEFT JOIN rows r ON r.id = l.dest_row_id
    WHERE l.source_row_id = ? AND l.dest_sheet_id = ? AND l.user_id = ? AND EXISTS (SELECT 1 FROM http_runs hr
      WHERE hr.id = l.run_id AND hr.sheet_id = ? AND hr.user_id = ? AND hr.master_column_name = ?)`)
    .all(j.source_row_id, j.dest_sheet_id, j.user_id, j.source_sheet_id, j.user_id, column) as
    Array<{ dest_row_id: string; row_index: number | null }>;
}

// Waiting for a paused run on the destination (services/enrich-list-dest-run.ts):
// recorded, and the source row names the run, the first time.
function waitForRun(j: Journal, column: string | null, name: string, run: DestRun | null): AddOutcome {
  if (j.wait_reason !== 'dest_run') {
    db.prepare("UPDATE enrichment_list_items SET wait_reason = 'dest_run', updated_at = datetime('now') WHERE id = ?")
      .run(j.id);
    if (run?.paused) writeSourceCell(j, column, listCell.waitingPausedRun(j.item_count, name, run.column));
  }
  return { wait: 'dest_run' };
}

// Cells of each row to add, skipping results already added (when asked).
function rowsToAdd(
  list: EnrichListConfig, payload: Payload, j: Journal, replaced: Set<string>,
): { rows: Array<{ cells: Record<string, string>; key: string | null }>; skipped: number } {
  const copied: Record<string, string> = {};
  for (const c of list.copy) copied[c.to] = payload.copy[c.id] ?? '';
  const seen = new Set<string>();
  const there = db.prepare(`SELECT l.dest_row_id FROM enrichment_list_rows l JOIN rows r ON r.id = l.dest_row_id
    WHERE l.dest_sheet_id = ? AND l.dedupe_key = ? AND l.user_id = ?`);
  const rows: Array<{ cells: Record<string, string>; key: string | null }> = [];
  let skipped = 0;
  for (const item of payload.items) {
    const key = list.dedupe ? dedupeKey(item, list.dedupe.path) : null;
    if (key) {
      const found = (there.all(j.dest_sheet_id, key, j.user_id) as Array<{ dest_row_id: string }>)
        .some(r => !replaced.has(r.dest_row_id));
      if (seen.has(key) || found) { skipped++; continue; }
      seen.add(key);
    }
    rows.push({ cells: { ...copied, ...itemCells(item, list.fields ?? []) }, key });
  }
  return { rows, skipped };
}

export function addListItems(journalId: string, count: DestCount = { rows: null }): AddOutcome {
  let out: AddOutcome = { gone: true };
  let stopRunId: string | null = null, stopName = '';
  db.transaction(() => {
    const j = db.prepare(`SELECT id, user_id, run_id, source_sheet_id, source_row_id, dest_sheet_id, items_json,
      item_count, wait_reason FROM enrichment_list_items WHERE id = ? AND status = 'pending'`)
      .get(journalId) as Journal | undefined;
    if (!j) return;
    const run = db.prepare('SELECT config, master_column_name FROM http_runs WHERE id = ? AND user_id = ?')
      .get(j.run_id, j.user_id) as { config: string; master_column_name: string | null } | undefined;
    const name = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck()
      .get(j.dest_sheet_id, j.user_id) as string | undefined;
    if (!run || name === undefined) return;     // deleted with its run or sheet: the journal row goes too
    let config: EnrichRunConfig | null = null;
    try { config = JSON.parse(run.config); } catch { /* below */ }
    const list = listOf(config);
    const column = run.master_column_name;
    // No field to fill (its last column was deleted): it waits for fields to be picked again.
    if (!list?.fields?.length) {
      db.prepare("UPDATE enrichment_list_items SET wait_reason = 'fields', updated_at = datetime('now') WHERE id = ?")
        .run(j.id);
      writeSourceCell(j, column, listCell.waitingFields(j.item_count));
      out = { wait: 'fields' };
      return;
    }
    if (column && olderWaitsForRun(j, column)) {
      out = waitForRun(j, column, name, destRunBlocker(j.dest_sheet_id, j.user_id));
      return;
    }
    const earlier = column ? earlierRows(j, column) : [];
    const live = earlier.filter(e => e.row_index !== null);
    // A pending or running one ends by itself: still being added, tried again next round.
    const blocker = live.length ? destRunBlocker(j.dest_sheet_id, j.user_id) : null;
    if (blocker) { out = blocker.paused ? waitForRun(j, column, name, blocker) : { wait: 'dest_run' }; return; }
    const payload = JSON.parse(j.items_json) as Payload;
    const { rows, skipped } = rowsToAdd(list, payload, j, new Set(earlier.map(e => e.dest_row_id)));

    let have = count.rows;
    const after = (n: number) => n - live.length + rows.length;
    if (have === null || after(have) > MAX_ROWS_PER_SHEET - ENRICH_LIST_RECOUNT_SLACK) {
      have = countRows(j.dest_sheet_id, j.user_id);
    }
    count.rows = have;
    if (after(have) > MAX_ROWS_PER_SHEET) {
      if (j.wait_reason !== 'room') {
        db.prepare("UPDATE enrichment_list_items SET wait_reason = 'room', updated_at = datetime('now') WHERE id = ?")
          .run(j.id);
        writeSourceCell(j, column, listCell.waitingRoom(rows.length, name));
      }
      stopRunId = j.run_id; stopName = name;
      out = { wait: 'room' };
      return;
    }

    // Columns the rows fill that the sheet no longer lists come back, as a
    // webhook's do; past the column limit their values are left out.
    const listed = getSheetColumns(j.dest_sheet_id, j.user_id, false);
    const wanted = [...new Set([...list.copy.map(c => c.to), ...list.fields.map(f => f.columnName)])];
    const missing = wanted.filter(c => !listed.includes(c));
    const room = Math.max(0, MAX_COLUMNS_PER_SHEET - listed.length);
    appendColumnsToOrder(j.dest_sheet_id, j.user_id, missing.slice(0, room));
    const dropped = new Set(missing.slice(room));

    let next = nextRowIndex(j.dest_sheet_id, j.user_id);
    const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)');
    const from = db.prepare(`INSERT INTO enrichment_list_rows (dest_row_id, user_id, dest_sheet_id, source_sheet_id,
      source_row_id, status_column, run_id, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      const id = uuidv4();
      for (const c of dropped) delete r.cells[c];
      insert.run(id, j.dest_sheet_id, j.user_id, next++, JSON.stringify(r.cells));
      from.run(id, j.user_id, j.dest_sheet_id, j.source_sheet_id, j.source_row_id, column ?? '', j.run_id, r.key);
    }
    if (earlier.length) {
      const ids = JSON.stringify(earlier.map(e => e.dest_row_id));
      db.prepare('DELETE FROM rows WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?')
        .run(ids, j.dest_sheet_id, j.user_id);
      purgeResultsForRows(j.dest_sheet_id, j.user_id, live.map(e => e.row_index as number));
      db.prepare(`DELETE FROM enrichment_list_rows WHERE dest_row_id IN (SELECT value FROM json_each(?))
        AND user_id = ?`).run(ids, j.user_id);
      if (live.length) autorunRowsRemoved(j.dest_sheet_id, j.user_id);
    }
    count.rows = after(have);
    writeSourceCell(j, column, listCell.added(rows.length, skipped));
    db.prepare('DELETE FROM enrichment_list_items WHERE id = ?').run(j.id);
    db.prepare('UPDATE http_runs SET list_rows_added = list_rows_added + ? WHERE id = ? AND user_id = ?')
      .run(rows.length, j.run_id, j.user_id);
    bump(j.dest_sheet_id, j.user_id);
    out = { added: rows.length, skipped };
  }).immediate();
  // The wait is recorded either way: a stop that fails here is tried again next round.
  if (stopRunId) {
    try { stopForRoom(stopRunId, stopName); } catch (error) {
      console.error(`Stopping run ${stopRunId} for a full sheet failed (tried again):`, redactError(error));
    }
  }
  return out;
}

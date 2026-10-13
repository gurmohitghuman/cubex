// A list job's journal rows as their source row and run see them: the source
// row's status cell (only while it shows a list job's own ➕ words), a journal
// row queued behind a full destination marked as waiting for room, the run a
// full destination stops, and the rows told their destination was deleted.
// Called inside the drain's transactions and a deleted destination's
// (services/run-control.ts).
import { db } from '../lib/db';
import { jsonPath } from '../lib/sql-helpers';
import { redactSecrets } from '../lib/redact';
import { listCell, LIST_MARK } from '../lib/enrich-list';
import { parseTargetRows } from '../lib/run-targets';
import { markAutorunInputs } from '../lib/autorun-mark';
import { destFullMessage } from './enrich-list-room';
import { loadEntry, pauseEntry } from './autorun-entry';
import { stopAutorunRun } from './autorun-stop';
import type { HTTPRunRow } from './http-runner-status';

type JournalRef = { id: string; user_id: string; run_id: string; source_sheet_id: string; source_row_id: string };

const bump = (sheetId: string, userId: string) => db.prepare(
  "UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
).run(sheetId, userId);

// A newer run's results for the same source row and column are on their way:
// the row's cell is theirs to write (rowids only grow while rows coexist).
const newerPending = (j: JournalRef, column: string): boolean => !!db.prepare(`SELECT 1
    FROM enrichment_list_items li JOIN http_runs r ON r.id = li.run_id
  WHERE li.source_row_id = ? AND li.status = 'pending' AND li.user_id = ?
    AND li.rowid > (SELECT rowid FROM enrichment_list_items WHERE id = ?)
    AND r.sheet_id = ? AND r.master_column_name = ? LIMIT 1`)
  .get(j.source_row_id, j.user_id, j.id, j.source_sheet_id, column);

// The source row's status cell (and its result's stored cells), while it
// still shows a list job's own words (➕): a newer run's ⏳ or a person's
// edit there stays, and a newer run's results still on their way write it.
export function writeSourceCell(j: JournalRef, column: string | null, cell: string): boolean {
  if (!column) return false;
  const path = jsonPath(column);
  const src = db.prepare(`SELECT row_index, json_extract(data, ?) AS cell FROM rows
    WHERE id = ? AND sheet_id = ? AND user_id = ?`).get(path, j.source_row_id, j.source_sheet_id, j.user_id) as
    { row_index: number; cell: unknown } | undefined;
  if (!src || !String(src.cell ?? '').trimStart().startsWith(LIST_MARK)) return false;
  const stored = db.prepare(`UPDATE http_results
    SET extracted_fields = json_set(COALESCE(extracted_fields, '{}'), ?, ?), updated_at = datetime('now')
    WHERE run_id = ? AND row_index = ? AND user_id = ?`);
  if (newerPending(j, column)) {
    stored.run(path, cell, j.run_id, src.row_index, j.user_id);
    return false;
  }
  db.prepare(`UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
    .run(path, cell, j.source_row_id, j.user_id);
  stored.run(path, cell, j.run_id, src.row_index, j.user_id);
  // Another auto-run may read this column: a written input queues the row.
  markAutorunInputs(j.source_sheet_id, j.user_id, [column], { ids: [j.source_row_id] });
  bump(j.source_sheet_id, j.user_id);
  return true;
}

// Destinations about to be deleted (in the delete transaction, before the
// cascade drops their journal rows): the source rows still showing ➕ say the
// results weren't added, unless results of the same column are still on
// their way to another sheet (that one writes the cell). One statement set
// per source column, however many rows wait.
export function destsGone(destIds: string[], cell: string): void {
  const ids = JSON.stringify(destIds);
  const groups = db.prepare(`SELECT li.source_sheet_id AS sheet, li.user_id, r.master_column_name AS col
    FROM enrichment_list_items li JOIN http_runs r ON r.id = li.run_id
    WHERE li.dest_sheet_id IN (SELECT value FROM json_each(?)) AND li.status = 'pending'
      AND r.master_column_name IS NOT NULL
    GROUP BY li.source_sheet_id, li.user_id, r.master_column_name`).all(ids) as
    Array<{ sheet: string; user_id: string; col: string }>;
  for (const g of groups) {
    const path = jsonPath(g.col);
    const rowIds = db.prepare(`SELECT DISTINCT li.source_row_id FROM enrichment_list_items li
        JOIN http_runs r ON r.id = li.run_id
      WHERE li.dest_sheet_id IN (SELECT value FROM json_each(?)) AND li.status = 'pending'
        AND li.source_sheet_id = ? AND li.user_id = ? AND r.master_column_name = ?
        AND NOT EXISTS (SELECT 1 FROM enrichment_list_items o JOIN http_runs orun ON orun.id = o.run_id
          WHERE o.source_row_id = li.source_row_id AND o.status = 'pending'
            AND o.dest_sheet_id NOT IN (SELECT value FROM json_each(?)) AND orun.master_column_name = ?)`)
      .pluck().all(ids, g.sheet, g.user_id, g.col, ids, g.col) as string[];
    if (rowIds.length === 0) continue;
    db.prepare(`UPDATE http_results SET extracted_fields = json_set(COALESCE(extracted_fields, '{}'), ?, ?),
        updated_at = datetime('now')
      WHERE +user_id = ? AND (run_id, row_index) IN (SELECT li.run_id, rw.row_index FROM enrichment_list_items li
        JOIN rows rw ON rw.id = li.source_row_id
        WHERE li.dest_sheet_id IN (SELECT value FROM json_each(?)) AND li.status = 'pending'
          AND li.source_sheet_id = ? AND li.source_row_id IN (SELECT value FROM json_each(?)))`)
      .run(path, cell, g.user_id, ids, g.sheet, JSON.stringify(rowIds));
    const written = db.prepare(`UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now')
      WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?
        AND substr(ltrim(json_extract(data, ?)), 1, 1) = ?`)
      .run(path, cell, JSON.stringify(rowIds), g.sheet, g.user_id, path, LIST_MARK).changes;
    if (written === 0) continue;
    markAutorunInputs(g.sheet, g.user_id, [g.col], { ids: rowIds });
    bump(g.sheet, g.user_id);
  }
}

// A run's results released together (fields picked for them): each source
// row's cell says its rows are on their way. Grouped by result count (at most
// ENRICH_LIST_MAX_ITEMS groups), so a few statements however many rows wait;
// a row a newer run's results are on their way to keeps that run's words.
export function releasedCells(
  run: { id: string; sheet_id: string; column: string | null }, userId: string, cellFor: (n: number) => string,
): void {
  if (!run.column) return;
  const path = jsonPath(run.column);
  const counts = db.prepare(`SELECT DISTINCT item_count FROM enrichment_list_items
    WHERE run_id = ? AND status = 'pending' AND wait_reason = 'fields' AND user_id = ?`)
    .pluck().all(run.id, userId) as number[];
  const written: string[] = [];
  for (const n of counts) {
    const cell = cellFor(n);
    const all = JSON.stringify(db.prepare(`SELECT source_row_id FROM enrichment_list_items
      WHERE run_id = ? AND status = 'pending' AND wait_reason = 'fields' AND user_id = ? AND item_count = ?`)
      .pluck().all(run.id, userId, n));
    db.prepare(`UPDATE http_results SET extracted_fields = json_set(COALESCE(extracted_fields, '{}'), ?, ?),
        updated_at = datetime('now')
      WHERE +user_id = ? AND run_id = ? AND row_index IN (SELECT row_index FROM rows
        WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?)`)
      .run(path, cell, userId, run.id, all, run.sheet_id, userId);
    const own = db.prepare(`SELECT li.source_row_id FROM enrichment_list_items li
      WHERE li.run_id = ? AND li.status = 'pending' AND li.wait_reason = 'fields' AND li.user_id = ?
        AND li.item_count = ? AND NOT EXISTS (SELECT 1 FROM enrichment_list_items o
          JOIN http_runs orun ON orun.id = o.run_id
          WHERE o.source_row_id = li.source_row_id AND o.status = 'pending' AND o.rowid > li.rowid
            AND orun.sheet_id = ? AND orun.master_column_name = ?)`)
      .pluck().all(run.id, userId, n, run.sheet_id, run.column) as string[];
    const ids = db.prepare(`UPDATE rows SET data = json_set(data, ?, ?), updated_at = datetime('now')
      WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?
        AND substr(ltrim(json_extract(data, ?)), 1, 1) = ? RETURNING id`)
      .pluck().all(path, cell, JSON.stringify(own), run.sheet_id, userId, path, LIST_MARK) as string[];
    written.push(...ids);
  }
  if (written.length === 0) return;
  markAutorunInputs(run.sheet_id, userId, [run.column], { ids: written });
  bump(run.sheet_id, userId);
}

// A journal row queued behind one that waits for room waits for room too: so
// it never holds the sheet (deleting rows there is how room is made), and its
// row says why.
export function waitForRoom(journalId: string): void {
  db.transaction(() => {
    const j = db.prepare(`SELECT li.id, li.user_id, li.run_id, li.source_sheet_id, li.source_row_id,
        li.item_count AS n, s.name, r.master_column_name AS col
      FROM enrichment_list_items li JOIN sheets s ON s.id = li.dest_sheet_id JOIN http_runs r ON r.id = li.run_id
      WHERE li.id = ? AND li.status = 'pending' AND li.wait_reason IS NULL`).get(journalId) as
      (JournalRef & { n: number; name: string; col: string | null }) | undefined;
    if (!j) return;
    db.prepare("UPDATE enrichment_list_items SET wait_reason = 'room', updated_at = datetime('now') WHERE id = ?")
      .run(j.id);
    writeSourceCell(j, j.col, listCell.waitingRoom(j.n, j.name));
  }).immediate();
}

// The full destination stops the run that fills it: a person's run pauses (Resume
// once there's room), an auto-run run cancels itself and its auto-run waits for room.
export function stopForRoom(runId: string, name: string): void {
  const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as HTTPRunRow | undefined;
  if (!run || !['pending', 'running'].includes(run.status)) return;
  // A sheet name is the user's own text: redacted like every run's error_message.
  const message = redactSecrets(destFullMessage(name));
  if (!run.autorun_id) {
    db.prepare(`UPDATE http_runs SET status = 'paused', pause_reason = 'dest_full', error_message = ?,
        updated_at = datetime('now') WHERE id = ? AND status IN ('pending', 'running') AND placeholder_work IS NULL`)
      .run(message, runId);
    return;
  }
  if (loadEntry(run.autorun_id)) {
    pauseEntry(run.autorun_id, 'dest_full', `${name} is full. Auto-run goes on once there's room.`);
  }
  // Its rows go back in the queue and its ⏳ cells clear (after this transaction).
  void stopAutorunRun(run, run.worker_generation, 'dest_full', message, parseTargetRows(run.target_rows));
}

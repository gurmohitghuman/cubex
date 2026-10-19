import { db } from './db';
import { markTemplateColumnGone } from './column-ref-rename';
import { renameHttpConfigColumn } from './http-config-rename';
import { deleteListDestPage, renameListDestPage } from './list-dest-columns';

// HTTP-run ↔ column lifecycle cascade, called from the column rename route
// (sheets-columns-order.ts). Mirrors lib/webhook-columns.ts.
//
// Why this is needed: an HTTP run stores its column names in TWO places —
// http_column_associations (kept in sync by name in the rename handler already)
// AND http_runs.config (a JSON blob whose responseMapping[].columnName holds the
// extracted column names) + http_runs.master_column_name. A rerun reads
// http_runs.config / master_column_name to decide where the worker writes
// results. If a rename updated only the associations, a later rerun would write
// results to the OLD column name (resurrecting it) while placeholders went to the
// NEW name (leaving it stuck on '⏳ Processing...'). So rename must rewrite the
// stored config too.
//
// Rename is the ONLY place with the unambiguous oldName→newName pairing: the
// associations table doesn't store the jsonPath↔column mapping, so reconciling at
// rerun time can't disambiguate which mapping a renamed column belongs to when a
// run has multiple mappings. Fix it here, where the pair is known.
//
// Call INSIDE the rename transaction. Uses strict (case-sensitive) equality: the
// rename route already rejects case-insensitive duplicates, and we only want to
// rewrite the exact stored key. This does every page at once, the sheet's own
// runs and the list jobs adding rows into it (lib/list-dest-columns.ts); the
// rename itself goes by page (services/run-config-rewrite.ts).
export function renameHttpRunColumnRefs(
  sheetId: string, userId: string, oldName: string, newName: string,
): void {
  for (let before: number | null = Number.MAX_SAFE_INTEGER; before !== null;) {
    before = renameHttpRunsPage(sheetId, userId, oldName, newName, before, RUNS_PAGE);
  }
  for (let before: number | null = Number.MAX_SAFE_INTEGER; before !== null;) {
    before = renameListDestPage(sheetId, userId, oldName, newName, before, RUNS_PAGE);
  }
}

// A sheet's runs a page at a time, newest first (rowid < before): a column
// with tens of thousands of runs is rewritten in slices
// (services/run-config-rewrite.ts). Returns the page's lowest rowid, or null
// when no run is left.
export const RUNS_PAGE = 200;
const pageOf = (sheetId: string, userId: string, before: number, limit: number) => db.prepare(
  `SELECT rowid AS rid, id, master_column_name AS master, config FROM http_runs
   WHERE sheet_id = ? AND user_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
).all(sheetId, userId, before, limit) as PageRun[];

export function renameHttpRunsPage(
  sheetId: string, userId: string, oldName: string, newName: string, before: number, limit: number,
): number | null {
  const page = pageOf(sheetId, userId, before, limit);
  if (page.length === 0) return null;
  renameRuns(page, oldName, newName);
  return page[page.length - 1].rid;
}

// The renamed or deleted column's own newest runs (the switch does these
// first, so the column keeps its runs while the rest are rewritten).
const columnNewest = (sheetId: string, userId: string, column: string, limit: number) => db.prepare(
  `SELECT rowid AS rid, id, master_column_name AS master, config FROM http_runs
   WHERE sheet_id = ? AND user_id = ? AND master_column_name = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
).all(sheetId, userId, column, limit) as PageRun[];

// Every column's newest run too: what each column reads now (out-of-date
// results, lib/run-inputs) follows the rename or delete at once, not when the
// pages reach it.
const mastersNewest = (sheetId: string, userId: string) => db.prepare(
  `SELECT rowid AS rid, id, master_column_name AS master, config FROM http_runs
   WHERE rowid IN (SELECT MAX(rowid) FROM http_runs WHERE sheet_id = ? AND master_column_name IS NOT NULL
     GROUP BY master_column_name) AND user_id = ?`,
).all(sheetId, userId) as PageRun[];

export function renameColumnNewest(sheetId: string, userId: string, oldName: string, newName: string): void {
  renameRuns(columnNewest(sheetId, userId, oldName, RUNS_PAGE), oldName, newName);
  renameRuns(mastersNewest(sheetId, userId), oldName, newName);
}

export function deleteColumnNewest(sheetId: string, userId: string, columnName: string): void {
  deleteRuns(columnNewest(sheetId, userId, columnName, RUNS_PAGE), columnName);
  deleteRuns(mastersNewest(sheetId, userId), columnName);
}

type PageRun = { rid: number; id: string; master: string | null; config: string | null };

function renameRuns(page: PageRun[], oldName: string, newName: string): void {
  // Master column lives in its own column — a plain UPDATE.
  const master = db.prepare('UPDATE http_runs SET master_column_name = ? WHERE id = ?');
  for (const r of page) if (r.master === oldName) master.run(newName, r.id);

  // responseMapping[].columnName lives inside the config JSON. Rewrite in JS —
  // only the runs whose config actually references oldName get re-serialized.
  const runs = page.filter((r): r is typeof r & { config: string } => r.config !== null);

  const update = db.prepare(`UPDATE http_runs SET config = ? WHERE id = ?`);
  for (const run of runs) {
    let config: any;
    try { config = JSON.parse(run.config); } catch { continue; } // malformed — leave it
    if (renameHttpConfigColumn(config, oldName, newName)) update.run(JSON.stringify(config), run.id);
  }
}

// On column DELETE: retire every stored HTTP-run reference to the deleted column.
// Call INSIDE the delete transaction.
//   1. If the deleted column is a run's MASTER column, NULL out
//      http_runs.master_column_name. Otherwise the zombie ref keeps
//      getColumnTypes (column-types.ts) classifying a later same-named column as
//      'http-master', and /http/rerun can find the stale run and resurrect its
//      old extracted columns.
//   2. Prune the deleted column from every stored config's responseMapping so a
//      later rerun doesn't re-create / write a column the user removed.
// (The association rows are deleted separately by the delete route.)
export function deleteHttpRunColumnRefs(
  sheetId: string, userId: string, columnName: string,
): void {
  for (let before: number | null = Number.MAX_SAFE_INTEGER; before !== null;) {
    before = deleteHttpRunsPage(sheetId, userId, columnName, before, RUNS_PAGE);
  }
  for (let before: number | null = Number.MAX_SAFE_INTEGER; before !== null;) {
    before = deleteListDestPage(sheetId, userId, columnName, before, RUNS_PAGE);
  }
}

export function deleteHttpRunsPage(
  sheetId: string, userId: string, columnName: string, before: number, limit: number,
): number | null {
  const page = pageOf(sheetId, userId, before, limit);
  if (page.length === 0) return null;
  deleteRuns(page, columnName);
  return page[page.length - 1].rid;
}

function deleteRuns(page: PageRun[], columnName: string): void {
  // (1) Retire the master ref if this column WAS a master column.
  const master = db.prepare('UPDATE http_runs SET master_column_name = NULL WHERE id = ?');
  for (const r of page) if (r.master === columnName) master.run(r.id);

  // (2) Prune extracted-column mappings from stored configs.
  const runs = page.filter((r): r is typeof r & { config: string } => r.config !== null);

  const update = db.prepare(`UPDATE http_runs SET config = ? WHERE id = ?`);
  for (const run of runs) {
    let config: any;
    try { config = JSON.parse(run.config); } catch { continue; }
    let changed = false;
    const mappings = config?.responseMapping;
    if (Array.isArray(mappings)) {
      const pruned = mappings.filter((m: any) => !m || m.columnName !== columnName);
      if (pruned.length !== mappings.length) { config.responseMapping = pruned; changed = true; }
    }
    // A request that read it never sends a saved key of its name instead
    // (an enrichment's inputs name columns only: no key stands in).
    const rc = config?.requestConfig;
    if (!config?.enrichment && rc && typeof rc === 'object' && markTemplateColumnGone(rc, columnName)) changed = true;
    // A list job stops copying a deleted column into its new rows.
    const list = config?.enrichment?.list;
    if (Array.isArray(list?.copy) && list.copy.some((c: any) => c?.from === columnName)) {
      list.copy = list.copy.filter((c: any) => c?.from !== columnName);
      changed = true;
    }
    if (changed) update.run(JSON.stringify(config), run.id);
  }
}

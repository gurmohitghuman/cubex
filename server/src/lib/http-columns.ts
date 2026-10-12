// Over 200 lines: the whole HTTP-run side of a column rename or delete; split, the rewrites would scatter.
import { db } from './db';
import { renameRuleColumn } from './run-condition';
import { renameTemplateColumnRefs } from './column-ref-rename';

// HTTP-run ↔ column lifecycle cascade, called from the column rename route
// (sheets-columns-order.ts). Mirrors lib/webhook-columns.ts.
// Over 200 lines: rename and delete rewrite the same stored run configs, by page.
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
// rewrite the exact stored key.
export function renameHttpRunColumnRefs(
  sheetId: string, userId: string, oldName: string, newName: string,
): void {
  for (let before: number | null = Number.MAX_SAFE_INTEGER; before !== null;) {
    before = renameHttpRunsPage(sheetId, userId, oldName, newName, before, RUNS_PAGE);
  }
  renameListDestColumn(sheetId, userId, oldName, newName);
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

export function renameColumnNewest(sheetId: string, userId: string, oldName: string, newName: string): void {
  renameRuns(columnNewest(sheetId, userId, oldName, RUNS_PAGE), oldName, newName);
}

export function deleteColumnNewest(sheetId: string, userId: string, columnName: string): void {
  deleteRuns(columnNewest(sheetId, userId, columnName, RUNS_PAGE), columnName);
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
    let changed = false;
    const mappings = config?.responseMapping;
    if (Array.isArray(mappings)) {
      for (const m of mappings) {
        if (m && m.columnName === oldName) { m.columnName = newName; changed = true; }
      }
    }
    // The request's {{column}} and /column references follow the rename too, or
    // a re-run sends "[MISSING: ...]" and overwrites good results with failures.
    const rc = config?.requestConfig;
    const rewrite = (v: unknown) => (typeof v === 'string' ? renameTemplateColumnRefs(v, oldName, newName) : v);
    if (rc && typeof rc === 'object') {
      for (const key of ['url', 'body'] as const) {
        const next = rewrite(rc[key]);
        if (next !== rc[key]) { rc[key] = next; changed = true; }
      }
      if (rc.headers && typeof rc.headers === 'object') {
        // Header names are templated too (makeHTTPRequest substitutes both).
        const headers: Record<string, unknown> = {};
        for (const [h, v] of Object.entries(rc.headers)) {
          const name = rewrite(h) as string;
          const value = rewrite(v);
          if (name !== h || value !== v) changed = true;
          headers[name] = value;
        }
        rc.headers = headers;
      }
    }
    // "Only run if" names columns too (the rule, and an enrichment's older
    // condition list), and so do a list job's copied columns (read from this sheet).
    if (typeof config?.runIf === 'string') {
      const runIf = renameRuleColumn(config.runIf, oldName, newName);
      if (runIf !== config.runIf) { config.runIf = runIf; changed = true; }
    }
    const where = config?.enrichment?.rows?.where;
    if (Array.isArray(where)) {
      for (const c of where) if (c && c.column === oldName) { c.column = newName; changed = true; }
    }
    const copy = config?.enrichment?.list?.copy;
    if (Array.isArray(copy)) {
      for (const c of copy) if (c && c.from === oldName) { c.from = newName; changed = true; }
    }
    if (changed) update.run(JSON.stringify(config), run.id);
  }
}

// List jobs adding rows to this sheet (from another one) name its columns:
// the fields they keep and the columns they copy into.
function listRunsInto(sheetId: string, userId: string): Array<{ id: string; config: any }> {
  const rows = db.prepare('SELECT id, config FROM http_runs WHERE dest_sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as Array<{ id: string; config: string }>;
  return rows.flatMap(r => {
    try { const config = JSON.parse(r.config); return config?.enrichment?.list ? [{ id: r.id, config }] : []; }
    catch { return []; }
  });
}

export function renameListDestColumn(sheetId: string, userId: string, oldName: string, newName: string): void {
  const update = db.prepare('UPDATE http_runs SET config = ? WHERE id = ?');
  for (const run of listRunsInto(sheetId, userId)) {
    const list = run.config.enrichment.list;
    let changed = false;
    for (const f of list.fields ?? []) if (f.columnName === oldName) { f.columnName = newName; changed = true; }
    for (const c of list.copy ?? []) if (c.to === oldName) { c.to = newName; changed = true; }
    if (changed) update.run(JSON.stringify(run.config), run.id);
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
  deleteListDestColumn(sheetId, userId, columnName);
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
    // A list job stops copying a deleted column into its new rows.
    const list = config?.enrichment?.list;
    if (Array.isArray(list?.copy) && list.copy.some((c: any) => c?.from === columnName)) {
      list.copy = list.copy.filter((c: any) => c?.from !== columnName);
      changed = true;
    }
    if (changed) update.run(JSON.stringify(config), run.id);
  }
}

// List jobs adding rows here stop filling the deleted column. Call inside the
// delete's transaction (a sheet has few runs adding rows into it).
export function deleteListDestColumn(sheetId: string, userId: string, columnName: string): void {
  const update = db.prepare('UPDATE http_runs SET config = ? WHERE id = ?');
  for (const run of listRunsInto(sheetId, userId)) {
    const list = run.config.enrichment.list;
    const fields = (list.fields ?? []).filter((f: any) => f.columnName !== columnName);
    const copy = (list.copy ?? []).filter((c: any) => c.to !== columnName);
    if (fields.length === (list.fields ?? []).length && copy.length === (list.copy ?? []).length) continue;
    // No field left: its results wait until fields are picked again (never blank rows).
    if (list.fields) list.fields = fields.length ? fields : null;
    list.copy = copy;
    update.run(JSON.stringify(run.config), run.id);
  }
}

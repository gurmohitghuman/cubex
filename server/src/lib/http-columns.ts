import { db } from './db';
import { renameTemplateColumnRefs } from './column-ref-rename';

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
// rewrite the exact stored key.
export function renameHttpRunColumnRefs(
  sheetId: string, userId: string, oldName: string, newName: string,
): void {
  // Master column lives in its own column — a plain UPDATE.
  db.prepare(
    `UPDATE http_runs SET master_column_name = ?
       WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?`,
  ).run(newName, sheetId, userId, oldName);

  // responseMapping[].columnName lives inside the config JSON. Rewrite in JS —
  // only the runs whose config actually references oldName get re-serialized.
  const runs = db.prepare(
    `SELECT id, config FROM http_runs WHERE sheet_id = ? AND user_id = ? AND config IS NOT NULL`,
  ).all(sheetId, userId) as Array<{ id: string; config: string }>;

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
    if (changed) update.run(JSON.stringify(config), run.id);
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
  // (1) Retire the master ref if this column WAS a master column.
  db.prepare(
    `UPDATE http_runs SET master_column_name = NULL
       WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?`,
  ).run(sheetId, userId, columnName);

  // (2) Prune extracted-column mappings from stored configs.
  const runs = db.prepare(
    `SELECT id, config FROM http_runs WHERE sheet_id = ? AND user_id = ? AND config IS NOT NULL`,
  ).all(sheetId, userId) as Array<{ id: string; config: string }>;

  const update = db.prepare(`UPDATE http_runs SET config = ? WHERE id = ?`);
  for (const run of runs) {
    let config: any;
    try { config = JSON.parse(run.config); } catch { continue; }
    const mappings = config?.responseMapping;
    if (!Array.isArray(mappings)) continue;
    const pruned = mappings.filter((m: any) => !m || m.columnName !== columnName);
    if (pruned.length !== mappings.length) {
      config.responseMapping = pruned;
      update.run(JSON.stringify(config), run.id);
    }
  }
}

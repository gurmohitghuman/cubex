// List jobs adding rows to a sheet from another one name its columns: the
// fields they keep (list.fields[].columnName) and the columns they copy into
// (list.copy[].to). Renaming or deleting one of those columns rewrites them.
// Auto-run leaves a run per batch, so thousands of runs can add rows into one
// sheet: they go a page at a time, newest first, through the destination's
// index (services/run-config-rewrite.ts runs the pages with the sheet busy).
// Each function returns the page's lowest rowid, or null when no run is left.
// Call inside a transaction.
import { db } from './db';

type DestRun = { rid: number; id: string; config: string | null };
type ListConfig = { fields?: unknown; copy?: unknown };
type Named = { columnName?: unknown; to?: unknown };

const destPage = (destId: string, userId: string, before: number, limit: number) => db.prepare(
  `SELECT rowid AS rid, id, config FROM http_runs
   WHERE dest_sheet_id = ? AND user_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
).all(destId, userId, before, limit) as DestRun[];

// Each run's list config through `edit` (true: it changed, store it).
function rewritePage(
  destId: string, userId: string, before: number, limit: number, edit: (list: ListConfig) => boolean,
): number | null {
  const page = destPage(destId, userId, before, limit);
  if (page.length === 0) return null;
  const update = db.prepare('UPDATE http_runs SET config = ? WHERE id = ?');
  for (const run of page) {
    let config: any;
    try { config = JSON.parse(run.config ?? 'null'); } catch { continue; } // malformed: leave it
    const list = config?.enrichment?.list;
    if (list && typeof list === 'object' && edit(list)) update.run(JSON.stringify(config), run.id);
  }
  return page[page.length - 1].rid;
}

const entries = (v: unknown): Named[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);

export function renameListDestPage(
  destId: string, userId: string, oldName: string, newName: string, before: number, limit: number,
): number | null {
  return rewritePage(destId, userId, before, limit, list => {
    let changed = false;
    for (const f of entries(list.fields)) if (f.columnName === oldName) { f.columnName = newName; changed = true; }
    for (const c of entries(list.copy)) if (c.to === oldName) { c.to = newName; changed = true; }
    return changed;
  });
}

// The deleted column is no longer filled. No field left: the run's results
// wait until fields are picked again (never blank rows).
export function deleteListDestPage(
  destId: string, userId: string, column: string, before: number, limit: number,
): number | null {
  return rewritePage(destId, userId, before, limit, list => {
    const fields = entries(list.fields), copy = entries(list.copy);
    const keptFields = fields.filter(f => f.columnName !== column);
    const keptCopy = copy.filter(c => c.to !== column);
    if (keptFields.length === fields.length && keptCopy.length === copy.length) return false;
    if (list.fields) list.fields = keptFields.length ? keptFields : null;
    list.copy = keptCopy;
    return true;
  });
}

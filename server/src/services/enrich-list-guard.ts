// A list job adding rows to a sheet holds that sheet like a run on it: a sort,
// a CSV replace, row deletes and transfers there wait (409) while the run into
// it is pending or running, or while its rows are being added. Not while they
// wait for fields (a test nobody finished) or for room: deleting rows is how
// a full sheet gets room.
import { db } from '../lib/db';

export interface ListIntoBlock { runId: string; column: string | null; message: string }

export function listRunInto(sheetId: string, userId: string): ListIntoBlock | null {
  const r = (db.prepare(`SELECT r.id, r.master_column_name AS col, s.name FROM http_runs r
      JOIN sheets s ON s.id = r.sheet_id
    WHERE r.dest_sheet_id = ? AND r.user_id = ? AND r.status IN ('pending', 'running') LIMIT 1`)
    .get(sheetId, userId) ?? db.prepare(`SELECT r.id, r.master_column_name AS col, s.name
      FROM enrichment_list_items li JOIN http_runs r ON r.id = li.run_id JOIN sheets s ON s.id = li.source_sheet_id
    WHERE li.dest_sheet_id = ? AND li.user_id = ? AND li.status = 'pending' AND li.wait_reason IS NULL LIMIT 1`)
    .get(sheetId, userId)) as { id: string; col: string | null; name: string } | undefined;
  if (!r) return null;
  const by = r.col ? `${r.col} in ${r.name}` : r.name;
  return {
    runId: r.id, column: r.col,
    message: `Rows are being added to this sheet by ${by}. Try again when that finishes.`,
  };
}

// The last field a list run into this sheet keeps (pending, running or
// paused): deleting its column would leave the run buying results that can't
// become rows (they'd wait for fields), so the delete waits for the run.
export function lastKeptField(sheetId: string, userId: string, column: string): string | null {
  const runs = db.prepare(`SELECT r.config, r.master_column_name AS col, s.name FROM http_runs r
      JOIN sheets s ON s.id = r.sheet_id
    WHERE r.dest_sheet_id = ? AND r.user_id = ? AND r.status IN ('pending', 'running', 'paused')`)
    .all(sheetId, userId) as Array<{ config: string; col: string | null; name: string }>;
  for (const r of runs) {
    let fields: unknown;
    try { fields = JSON.parse(r.config)?.enrichment?.list?.fields; } catch { continue; }
    if (!Array.isArray(fields) || fields.length === 0) continue;
    if (fields.every(f => (f as { columnName?: unknown })?.columnName === column)) {
      const by = r.col ? `${r.col} in ${r.name}` : r.name;
      return `Cannot delete ${column}: it's the only field ${by} keeps in the rows it adds here. `
        + 'Stop that run first, then delete it.';
    }
  }
  return null;
}

// Results this sheet's list columns bought that aren't rows yet (being added,
// waiting for room or for fields). Deleting the sheet drops them with its
// journal: the delete confirm and the API's delete answer say so.
export interface ResultsNotAdded { results: number; sheets: string[] }
export function resultsNotAdded(sourceSheetId: string, userId: string): ResultsNotAdded | null {
  const rows = db.prepare(`SELECT s.name, IFNULL(SUM(li.item_count), 0) AS n FROM enrichment_list_items li
      JOIN sheets s ON s.id = li.dest_sheet_id
    WHERE li.source_sheet_id = ? AND li.status = 'pending' AND li.user_id = ?
    GROUP BY li.dest_sheet_id ORDER BY s.position`).all(sourceSheetId, userId) as Array<{ name: string; n: number }>;
  const results = rows.reduce((t, r) => t + r.n, 0);
  return results > 0 ? { results, sheets: rows.map(r => r.name) } : null;
}

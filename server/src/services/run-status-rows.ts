// include_status's out_of_date (lib/row-filter/status-rows.ts): which run
// columns' results are out of date in a page of rows, one query a page over
// the rows' primary key. A state column no run has fingerprinted is never
// asked about. The cell's own state (done, no result) is decided in JS.
import { db } from '../lib/db';
import type { RunColumnMap } from '../lib/row-filter/sql';

// rows.id → the state columns whose result in that row is out of date.
export function staleByRow(
  sheetId: string, userId: string, rowIds: readonly string[], runColumns: RunColumnMap,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (rowIds.length === 0 || !runColumns.staleFor) return out;
  const states = [...new Set(runColumns.values())].filter(s => runColumns.get(s) === s);
  const checks = states.flatMap(s => {
    const check = runColumns.staleFor!(s);
    return check ? [{ state: s, check }] : [];
  });
  if (checks.length === 0) return out;
  // By primary key: + keeps a planner without statistics off the sheet index (a whole-sheet scan).
  const rows = db.prepare(`SELECT id, ${checks.map(c => `${c.check.sql} IS 1`).join(', ')} FROM rows
    WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`).raw()
    .all(...checks.flatMap(c => c.check.params), JSON.stringify(rowIds), sheetId, userId) as unknown[][];
  for (const [id, ...flags] of rows) {
    const stale = new Set(checks.filter((_, i) => flags[i] === 1).map(c => c.state));
    if (stale.size > 0) out.set(id as string, stale);
  }
  return out;
}

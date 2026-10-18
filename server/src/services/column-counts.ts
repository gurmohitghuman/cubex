// get_sheet's include_counts: how many rows of each column are filled, empty
// or errors, in one walk over the sheet a slice at a time (lib/sheet-slices.ts,
// other requests in between), each slice one SELECT of sums over the run-state
// rules the filters use (lib/row-filter/sql.ts), so a count and a has_error
// filter always agree. filled: a value that isn't Cubex's own words (has_result;
// an enrichment's "✅ Found" counts). errors: "❌ …", or a blank output whose run
// failed (has_error). empty: every other row (blank, not run yet, skipped,
// condition not met, still running). Each cell is read once per row, in a
// materialized slice the sums then read (as aggregates do): a rule reads its
// cell three times otherwise. The slice keeps a cell's first 4 characters only:
// has_result and has_error look at nothing else (is it empty, does it start
// with a mark), and an enrichment's answer cell can hold 200,000. Like aggregates, it answers busy while a heavy
// operation moves the sheet's rows, and never reads them again in one go.
import { db } from '../lib/db';
import { jsonPath } from '../lib/json-path';
import { compileWhere, TRIMMED_CELL_SQL } from '../lib/row-filter/sql';
import { sliceSql, slicedUnlessBusy, walkSlices } from '../lib/sheet-slices';
import type { ColumnCounts } from '../lib/column-details';

export type CountsOutcome = { ok: Map<string, ColumnCounts> } | { busy: string } | { stopped: true };

// runColumns: the sheet's run columns → their state column (services/row-filter.ts sheetRunColumns).
export async function columnCounts(
  sheetId: string, userId: string, columns: readonly string[], runColumns: ReadonlyMap<string, string>,
  stop?: () => boolean,
): Promise<CountsOutcome> {
  if (columns.length === 0) return { ok: new Map() };
  // The cells the rules read: each counted column and the state column an output reads.
  const read = [...new Set(columns.flatMap(c => [c, runColumns.get(c) ?? c]))];
  const cells = new Map(read.map((c, i) => [c, `c${i}`]));
  const sums: string[] = [];
  const params: unknown[] = [];
  for (const column of columns) {
    for (const operator of ['has_result', 'has_error'] as const) {
      const rule = compileWhere([{ column, operator }], runColumns, cells);
      sums.push(`SUM(CASE WHEN ${rule.sql} THEN 1 ELSE 0 END)`);
      params.push(...rule.params);
    }
  }
  const stmt = db.prepare(`WITH t AS MATERIALIZED (
      SELECT ${read.map((_, i) => `substr(${TRIMMED_CELL_SQL}, 1, 4) AS c${i}`).join(', ')} FROM rows
      WHERE sheet_id = ? AND user_id = ? AND ${sliceSql()})
    SELECT COUNT(*), ${sums.join(', ')} FROM t`).raw();
  const paths = read.map(c => jsonPath(c));
  return slicedUnlessBusy(sheetId, async (): Promise<CountsOutcome> => {
    const totals = new Array<number>(1 + sums.length).fill(0);
    const finished = await walkSlices(sheetId, userId, { sliced: true, stop }, (a, b) => {
      const row = stmt.get(...paths, sheetId, userId, a, b, ...params) as Array<number | null>;
      row.forEach((v, i) => { totals[i] += v ?? 0; });
      return false;
    });
    if (!finished) return { stopped: true };
    const out = new Map<string, ColumnCounts>();
    columns.forEach((column, i) => {
      const filled = totals[1 + 2 * i];
      const errors = totals[2 + 2 * i];
      out.set(column, { filled, empty: totals[0] - filled - errors, errors });
    });
    return { ok: out };
  });
}

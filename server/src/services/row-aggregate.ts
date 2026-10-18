// Aggregate reads (lib/row-aggregate): read_rows' and REST rows/query's
// group_by and aggregates, and the grid's value counts. SQLite groups the rows
// of one slice at a time (lib/sheet-slices.ts, other requests in between) and
// the slices' groups add up in a GroupTally, so a million rows are never held,
// only their groups, and at most AGGREGATE_MAX_GROUPS of those.
import { db } from '../lib/db';
import { jsonPath } from '../lib/json-path';
import { sliceSql, slicedUnlessBusy, walkSlices } from '../lib/sheet-slices';
import { AGGREGATE_MAX_GROUPS, AGGREGATE_TOP_GROUPS } from '../lib/constants-query';
import { GroupTally, measuresFor, type MeasureKind } from '../lib/row-aggregate/groups';
import type { AggregateSpec } from '../lib/row-aggregate/spec';
import type { CompiledFilter } from '../lib/row-filter/sql';

// Numbers as gt/lt read them (cubex_num), text as eq/any_of compare it
// (cubex_fold): each cell's reading per row, then the aggregate over a group.
const MEASURE_SQL: Record<MeasureKind, { row: (cell: string) => string; group: (v: string) => string }> = {
  sum: { row: x => `cubex_num(${x})`, group: v => `SUM(${v})` },
  num: { row: x => `cubex_num(${x})`, group: v => `COUNT(${v})` },
  min: { row: x => `cubex_num(${x})`, group: v => `MIN(${v})` },
  max: { row: x => `cubex_num(${x})`, group: v => `MAX(${v})` },
  filled: { row: x => `cubex_fold(${x}) <> ''`, group: v => `SUM(${v})` },
};

export type AggregateResult = ReturnType<GroupTally['result']>;
// empty: rows whose every group_by cell is empty, ranked or not (the grid's value counts show it apart).
export type AggregateOutcome =
  | { ok: AggregateResult; empty: number } | { error: string } | { stopped: true } | { busy: string };

export const tooManyGroups = (spec: AggregateSpec): string =>
  `group_by ${spec.groupBy.map(c => `"${c}"`).join(', ')} finds more than `
  + `${AGGREGATE_MAX_GROUPS.toLocaleString('en-US')} different values in these rows. Group by columns with `
  + 'fewer different values, or narrow the rows with where.';

// One slice's groups: keys (folded), values as written, the row count, then
// the measures. Each cell is read once per row in a materialized subquery
// (SQLite would otherwise call cubex_num once per aggregate of the column):
// measured at 1M rows, 2.4 s instead of 3.4 s for five aggregates.
function sliceStatement(spec: AggregateSpec, filter: CompiledFilter) {
  const measures = measuresFor(spec);
  const params: unknown[] = [];
  const cell = (column: string) => { params.push(jsonPath(column)); return 'json_extract(data, ?)'; };
  // One reading per distinct (row expression, column): sum and avg share a column's number.
  const readings = new Map<string, { sql: string; alias: string }>();
  const reading = (m: { kind: MeasureKind; column: string }) => {
    const row = MEASURE_SQL[m.kind].row;
    const key = JSON.stringify([row('x'), m.column]);
    if (!readings.has(key)) readings.set(key, { sql: row(cell(m.column)), alias: `v${readings.size}` });
    return readings.get(key)!.alias;
  };
  const keys = spec.groupBy.map((c, i) => `cubex_fold(${cell(c)}) AS k${i}`);
  // A group's value as written: the smallest, outer spaces off (as GroupTally keeps it across slices).
  const labels = spec.groupBy.map((c, i) => `TRIM(${cell(c)}) AS l${i}`);
  const groups = measures.map((m, i) => `${MEASURE_SQL[m.kind].group(reading(m))} AS m${i}`);
  const inner = [...keys, ...labels, ...[...readings.values()].map(r => `${r.sql} AS ${r.alias}`)].join(', ') || '1';
  const outer = [...spec.groupBy.map((_, i) => `k${i}`), ...spec.groupBy.map((_, i) => `MIN(l${i})`), 'COUNT(*)',
    ...groups].join(', ');
  const groupBy = spec.groupBy.length ? `GROUP BY ${spec.groupBy.map((_, i) => `k${i}`).join(', ')}` : '';
  const stmt = db.prepare(`WITH t AS MATERIALIZED (SELECT ${inner} FROM rows
    WHERE sheet_id = ? AND user_id = ? AND ${sliceSql()} AND (${filter.sql}))
    SELECT ${outer} FROM t ${groupBy}`).raw();
  return { stmt, params, measures };
}

// filter: the read's `where` and view, compiled (null: every row). stop: asked
// between slices, true when the asker went away.
export async function aggregateRows(
  sheetId: string, userId: string, spec: AggregateSpec, filter: CompiledFilter | null,
  opts: { top?: number; stop?: () => boolean } = {},
): Promise<AggregateOutcome> {
  const f = filter ?? { sql: '1', params: [] };
  const { stmt, params, measures } = sliceStatement(spec, f);
  const g = spec.groupBy.length;
  return slicedUnlessBusy(sheetId, async (): Promise<AggregateOutcome> => {
    const tally = new GroupTally(measures);
    let tooMany = false;
    const finished = await walkSlices(sheetId, userId, { sliced: true, stop: opts.stop }, (a, b) => {
      for (const row of stmt.all(...params, sheetId, userId, a, b, ...f.params) as unknown[][]) {
        const added = tally.add({
          keys: row.slice(0, g) as string[], labels: row.slice(g, 2 * g), n: row[2 * g] as number,
          m: row.slice(2 * g + 1) as Array<number | null>,
        });
        if (!added) { tooMany = true; return true; }
      }
      return false;
    });
    if (tooMany) return { error: tooManyGroups(spec) };
    if (!finished) return { stopped: true };
    return { ok: tally.result(spec, opts.top ?? AGGREGATE_TOP_GROUPS), empty: tally.emptyRows(g) };
  });
}

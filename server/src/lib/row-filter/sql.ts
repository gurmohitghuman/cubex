// A `where` (where.ts) as one SQL condition over rows.data (pure), so every
// reader filters inside SQLite, a page or a slice at a time, never by loading
// rows. Text, number and date operators call foldText, asNumber and asDate
// (ops.ts, dates.ts) as the SQL functions cubex_fold, cubex_num and cubex_date
// (sql-functions.ts), so SQL and "Only run if" read cells alike. Run-state operators are the rules of
// cellStatus (cell-status.ts) in plain SQL over the run's own words.
import { jsonPath } from '../json-path';
import { BLANK_CHARS, CONDITION_NOT_MET, FAILED_MARK, LIST_MARK, RUNNING_MARK, SKIPPED_MARK } from '../run-markers';
import { asDate } from './dates';
import { asNumber, foldText, isDateOp, isListOp, isNumberOp, isStateOp, type StateOp } from './ops';
import {
  activeWhere, groupItems, isGroup, isOrGroup, type FilterCondition, type WhereItem,
} from './where';

// sql is a condition on the `rows` table's `data` column; params bind in order.
export interface CompiledFilter { sql: string; params: unknown[] }

// The sheet's run columns → the column holding their run's state, and, for
// out_of_date, the check that a state column's result is out of date
// (services/run-inputs.ts; null: no run has fingerprinted its rows).
export type RunColumnMap = ReadonlyMap<string, string> & {
  readonly staleFor?: (state: string) => CompiledFilter | null;
};

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const BLANK_SQL = `char(${[...BLANK_CHARS].map(c => c.codePointAt(0)).join(', ')})`;
const TRIMMED = `TRIM(COALESCE(json_extract(data, ?), ''), ${BLANK_SQL})`;
// A cell as the run-state rules read it (its path bound as the one parameter):
// a reader that reads each cell once (services/column-counts.ts) selects this
// and hands compileWhere the alias (`cells`).
export const TRIMMED_CELL_SQL = TRIMMED;
const FOLDED = 'cubex_fold(json_extract(data, ?))';

// Builds SQL left to right, binding each cell's path where it appears. cells:
// columns already read as TRIMMED_CELL_SQL, by the SQL naming them.
class Sql {
  readonly params: unknown[] = [];
  constructor(private readonly cells?: ReadonlyMap<string, string>) {}
  cell(column: string): string {
    const read = this.cells?.get(column);
    if (read) return read;
    this.params.push(jsonPath(column));
    return TRIMMED;
  }
  bind(value: unknown): string { this.params.push(value); return '?'; }
  // SQL compiled elsewhere, its parameters bound where it appears.
  embed(f: CompiledFilter): string { this.params.push(...f.params); return f.sql; }
  // The cell starts with one of `marks` (code points, as JS startsWith does
  // for these one-unit characters).
  startsWith(column: string, marks: string[]): string {
    const byLength = new Map<number, string[]>();
    for (const m of marks) byLength.set([...m].length, [...(byLength.get([...m].length) ?? []), m]);
    const parts = [...byLength].map(([n, ms]) =>
      `substr(${this.cell(column)}, 1, ${n}) IN (${ms.map(literal).join(', ')})`);
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  }
}

const ANY_MARK = [RUNNING_MARK, FAILED_MARK, SKIPPED_MARK, LIST_MARK];
const UNSETTLED = [RUNNING_MARK, LIST_MARK, FAILED_MARK];

// The cell holds a run's result: a value, or Cubex's words for none ("⏭️ Not
// found"), never a run still going, failed or kept out (cellStatus done or no_result).
function settled(q: Sql, column: string): string {
  return `(${q.cell(column)} <> '' AND NOT ${q.startsWith(column, UNSETTLED)} `
    + `AND ${q.cell(column)} <> ${literal(CONDITION_NOT_MET)})`;
}

// One run column's state. `state` is its status column (null: it is one).
function statePredicate(
  q: Sql, op: StateOp, column: string, state: string | null, runColumns: RunColumnMap,
): string {
  // A blank own cell defers to the status cell (cellStatus).
  const viaState = (own: string, onState: () => string) =>
    state === null ? own : `(${own} OR (${q.cell(column)} = '' AND ${onState()}))`;
  switch (op) {
    case 'has_result':
      return `(${q.cell(column)} <> '' AND NOT ${q.startsWith(column, ANY_MARK)})`;
    case 'has_error':
      return viaState(q.startsWith(column, [FAILED_MARK]), () => q.startsWith(state!, [FAILED_MARK]));
    case 'running':
      return viaState(q.startsWith(column, [RUNNING_MARK, LIST_MARK]),
        () => q.startsWith(state!, [RUNNING_MARK, LIST_MARK]));
    case 'condition_not_met':
      return viaState(`${q.cell(column)} = ${literal(CONDITION_NOT_MET)}`,
        () => `${q.cell(state!)} = ${literal(CONDITION_NOT_MET)}`);
    case 'not_run':
      return state === null ? `${q.cell(column)} = ''` : `(${q.cell(column)} = '' AND ${q.cell(state)} = '')`;
    case 'out_of_date': {
      // The run's fingerprints are kept under its state column (lib/run-inputs).
      const stale = runColumns.staleFor?.(state ?? column);
      if (!stale) return '0';
      const held = viaState(settled(q, column), () => settled(q, state!));
      return `(${held} AND ${q.embed(stale)})`;
    }
  }
}

// The folded cell starts (side 1) or ends (side -1) with `value`: its first or
// last length(value) characters equal it. The cell's path is already bound.
function affix(q: Sql, side: 1 | -1, value: string): string {
  const n = [...value].length;
  // Every text starts and ends with '' (the path stays bound: cubex_fold is never NULL).
  if (n === 0) return `${FOLDED} IS NOT NULL`;
  return side === 1
    ? `substr(${FOLDED}, 1, ${n}) = ${q.bind(value)}`
    : `substr(${FOLDED}, -${n}) = ${q.bind(value)}`;
}

function conditionSql(q: Sql, c: FilterCondition, runColumns: RunColumnMap): string {
  const op = c.operator;
  if (isStateOp(op)) {
    if (c.column !== undefined) {
      // A column no run fills any more (a saved grid filter) reads its own cell.
      const state = runColumns.get(c.column);
      return statePredicate(q, op, c.column, state !== undefined && state !== c.column ? state : null, runColumns);
    }
    // Any run column. A blank output reads its status column, which is a run
    // column itself (mapped to itself), so every run column's own cell finds
    // the same rows; "not run" and "out of date" need only the columns holding their own state.
    const own = op === 'not_run' || op === 'out_of_date';
    const columns = [...runColumns].filter(([col, state]) => !own || state === col).map(([col]) => col);
    if (columns.length === 0) return '0';
    const parts = columns.map(col => statePredicate(q, op, col, null, runColumns));
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  }
  const column = c.column!;
  if (isNumberOp(op)) {
    q.params.push(jsonPath(column));
    const sign = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    return `cubex_num(json_extract(data, ?)) ${sign} ${q.bind(asNumber(c.value))}`;
  }
  if (isDateOp(op)) {
    q.params.push(jsonPath(column));
    const sign = { date_eq: '=', date_neq: '<>', date_gt: '>', date_gte: '>=', date_lt: '<', date_lte: '<=' }[op];
    // NULL (no date in the cell) fails every comparison, <> included, as datePasses does.
    return `cubex_date(json_extract(data, ?)) ${sign} ${q.bind(asDate(c.value))}`;
  }
  q.params.push(jsonPath(column));
  if (isListOp(op)) {
    const list = q.bind(JSON.stringify((c.values ?? []).map(foldText)));
    return `${FOLDED} ${op === 'any_of' ? 'IN' : 'NOT IN'} (SELECT value FROM json_each(${list}))`;
  }
  switch (op) {
    case 'eq': return `${FOLDED} = ${q.bind(foldText(c.value))}`;
    case 'neq': return `${FOLDED} <> ${q.bind(foldText(c.value))}`;
    case 'contains': return `instr(${FOLDED}, ${q.bind(foldText(c.value))}) > 0`;
    case 'not_contains': return `instr(${FOLDED}, ${q.bind(foldText(c.value))}) = 0`;
    // substr counts characters, as length() does; JS startsWith counts UTF-16
    // units, which agree on the same folded text.
    case 'starts_with': return affix(q, 1, foldText(c.value));
    case 'ends_with': return affix(q, -1, foldText(c.value));
    case 'empty': return `${FOLDED} = ''`;
    case 'not_empty': return `${FOLDED} <> ''`;
  }
}

// runColumns: the sheet's run columns → the column holding their run's state
// (services/row-filter.ts sheetRunColumns: a state column is a run column
// mapped to itself). An empty `where`, or one whose conditions are all off,
// passes every row. cells: run-state conditions read these columns from the
// given SQL instead (see TRIMMED_CELL_SQL).
export function compileWhere(
  where: readonly WhereItem[], runColumns: RunColumnMap, cells?: ReadonlyMap<string, string>,
): CompiledFilter {
  const active = activeWhere(where);
  if (active.length === 0) return { sql: '1', params: [] };
  const q = new Sql(cells);
  const itemSql = (item: WhereItem): string => {
    if (!isGroup(item)) return `(${conditionSql(q, item, runColumns)})`;
    return `(${groupItems(item).map(itemSql).join(isOrGroup(item) ? ' OR ' : ' AND ')})`;
  };
  return { sql: active.map(itemSql).join(' AND '), params: q.params };
}

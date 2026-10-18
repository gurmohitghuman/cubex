// A `where` (where.ts) as one SQL condition over rows.data (pure), so every
// reader filters inside SQLite, a page or a slice at a time, never by loading
// rows. Text and number operators call foldText and asNumber (ops.ts) as the
// SQL functions cubex_fold and cubex_num (sql-functions.ts), so SQL and
// "Only run if" read cells alike. Run-state operators are the rules of
// cellStatus (cell-status.ts) in plain SQL over the run's own words.
import { jsonPath } from '../json-path';
import { BLANK_CHARS, CONDITION_NOT_MET, FAILED_MARK, LIST_MARK, RUNNING_MARK, SKIPPED_MARK } from '../run-markers';
import { asNumber, foldText, isListOp, isNumberOp, isStateOp, type StateOp } from './ops';
import { isOrGroup, type FilterCondition, type WhereItem } from './where';

// sql is a condition on the `rows` table's `data` column; params bind in order.
export interface CompiledFilter { sql: string; params: unknown[] }

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
const BLANK_SQL = `char(${[...BLANK_CHARS].map(c => c.codePointAt(0)).join(', ')})`;
const TRIMMED = `TRIM(COALESCE(json_extract(data, ?), ''), ${BLANK_SQL})`;
const FOLDED = 'cubex_fold(json_extract(data, ?))';

// Builds SQL left to right, binding each cell's path where it appears.
class Sql {
  readonly params: unknown[] = [];
  cell(column: string): string { this.params.push(jsonPath(column)); return TRIMMED; }
  bind(value: unknown): string { this.params.push(value); return '?'; }
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

// One run column's state. `state` is its status column (null: it is one).
function statePredicate(q: Sql, op: StateOp, column: string, state: string | null): string {
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

function conditionSql(q: Sql, c: FilterCondition, runColumns: ReadonlyMap<string, string>): string {
  const op = c.operator;
  if (isStateOp(op)) {
    if (c.column !== undefined) {
      // A column no run fills any more (a saved grid filter) reads its own cell.
      const state = runColumns.get(c.column);
      return statePredicate(q, op, c.column, state !== undefined && state !== c.column ? state : null);
    }
    // Any run column. A blank output reads its status column, which is a run
    // column itself (mapped to itself), so every run column's own cell finds
    // the same rows; "not run" needs only the columns holding their own state.
    const columns = [...runColumns].filter(([col, state]) => op !== 'not_run' || state === col).map(([col]) => col);
    if (columns.length === 0) return '0';
    const parts = columns.map(col => statePredicate(q, op, col, null));
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  }
  const column = c.column!;
  if (isNumberOp(op)) {
    q.params.push(jsonPath(column));
    const sign = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    return `cubex_num(json_extract(data, ?)) ${sign} ${q.bind(asNumber(c.value))}`;
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
// mapped to itself). An empty `where` passes every row.
export function compileWhere(where: readonly WhereItem[], runColumns: ReadonlyMap<string, string>): CompiledFilter {
  if (where.length === 0) return { sql: '1', params: [] };
  const q = new Sql();
  const parts = where.map(item => {
    if (!isOrGroup(item)) return `(${conditionSql(q, item, runColumns)})`;
    return `(${item.or.map(c => `(${conditionSql(q, c, runColumns)})`).join(' OR ')})`;
  });
  return { sql: parts.join(' AND '), params: q.params };
}

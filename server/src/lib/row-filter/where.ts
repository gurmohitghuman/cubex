// A `where` (pure): which rows read_rows, REST rows/query, CSV export,
// transfer_rows and transform_column take, and (one condition per column) the
// grid's column filters. A list of conditions that must all pass; an item can
// instead be an OR group, {"or": [conditions]}, which passes when any of its
// conditions does (one level: a group holds conditions, not groups).
import { MAX_FILTER_LIST_VALUES, MAX_FILTER_VALUE_CHARS, MAX_WHERE_CONDITIONS } from '../constants-filters';
import {
  FILTER_OPS, asNumber, foldText, isFilterOp, isListOp, isNumberOp, isStateOp, type FilterOp,
} from './ops';

export interface FilterCondition {
  // Optional for run-state operators only: left out, any run column.
  column?: string;
  operator: FilterOp;
  value?: string;
  values?: string[];
}
export interface OrGroup { or: FilterCondition[] }
export type WhereItem = FilterCondition | OrGroup;

export const isOrGroup = (item: WhereItem): item is OrGroup => 'or' in item;
export const whereConditions = (where: readonly WhereItem[]): FilterCondition[] =>
  where.flatMap(item => (isOrGroup(item) ? item.or : [item]));

const EXAMPLE = '{"column":"Status","operator":"eq","value":"Done"}';
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// One condition's shape: known keys and types only.
function conditionShape(raw: unknown): FilterCondition | string {
  if (!isObject(raw)) return `Each where condition is an object like ${EXAMPLE}.`;
  const extra = Object.keys(raw).filter(k => !['column', 'operator', 'value', 'values'].includes(k));
  if (extra.length) {
    return extra.includes('or')
      ? 'An OR group holds conditions, not other groups: {"or":[condition, condition]}.'
      : `Unknown key "${extra[0]}" in a where condition. A condition has column, operator, and value or values.`;
  }
  if (raw.column !== undefined && typeof raw.column !== 'string') return 'A where column is a column name (text).';
  if (!isFilterOp(String(raw.operator))) {
    return `Unknown where operator "${String(raw.operator)}". Use one of: ${FILTER_OPS.join(', ')}.`;
  }
  if (raw.value !== undefined && typeof raw.value !== 'string') {
    return 'where values are strings, numbers included (send "1000", not 1000).';
  }
  if (raw.values !== undefined && (!Array.isArray(raw.values) || raw.values.some(v => typeof v !== 'string'))) {
    return 'values is a list of strings, e.g. ["SaaS","Fintech"].';
  }
  return raw as unknown as FilterCondition;
}

// The shape of a JSON `where` (REST bodies, stored link options; MCP's zod
// schema in mcp/tool-helpers.ts says the same). What the values mean is
// checked against the sheet by checkWhere.
export function parseWhere(raw: unknown): { where: WhereItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'where must be a non-empty list of conditions (and OR groups).' };
  }
  const where: WhereItem[] = [];
  let count = 0;
  for (const item of raw) {
    if (isObject(item) && 'or' in item) {
      if (Object.keys(item).length !== 1) return { error: 'An OR group has only "or": {"or":[condition, ...]}.' };
      if (!Array.isArray(item.or) || item.or.length === 0) {
        return { error: 'An OR group is {"or":[condition, ...]} with at least one condition.' };
      }
      const group: FilterCondition[] = [];
      for (const c of item.or) {
        const shaped = conditionShape(c);
        if (typeof shaped === 'string') return { error: shaped };
        group.push(shaped);
      }
      count += group.length;
      where.push({ or: group });
    } else {
      const shaped = conditionShape(item);
      if (typeof shaped === 'string') return { error: shaped };
      count++;
      where.push(shaped);
    }
  }
  if (count > MAX_WHERE_CONDITIONS) return { error: `where can hold at most ${MAX_WHERE_CONDITIONS} conditions.` };
  return { where };
}

const tooLong = (v: string) => v.length > MAX_FILTER_VALUE_CHARS;
// Operators an empty value would make meaningless (every cell contains '').
const NEEDS_TEXT = new Set<FilterOp>(['contains', 'not_contains', 'starts_with', 'ends_with']);

// What one condition's operator needs, without the sheet: the grid's saved
// filters are checked with this alone. null = fine.
export function conditionValueError(c: FilterCondition): string | null {
  const op = c.operator;
  if (isStateOp(op)) {
    if (c.value !== undefined || c.values !== undefined) return `${op} takes no value.`;
    return null;
  }
  if (c.column === undefined) return `${op} needs a column.`;
  if (isListOp(op)) {
    if (c.value !== undefined) return `${op} takes values (a list), e.g. "values":["SaaS","Fintech"], not value.`;
    if (!c.values || c.values.length === 0) return `${op} needs values: a list of one or more strings.`;
    if (c.values.length > MAX_FILTER_LIST_VALUES) return `${op} can list at most ${MAX_FILTER_LIST_VALUES} values.`;
    if (c.values.some(tooLong)) return `A where value can be at most ${MAX_FILTER_VALUE_CHARS} characters.`;
    return null;
  }
  if (c.values !== undefined) return `values is only for any_of and not_any_of; ${op} takes value.`;
  if (op === 'empty' || op === 'not_empty') return c.value !== undefined ? `${op} does not accept a value` : null;
  if (c.value === undefined) return `${op} requires a value`;
  if (tooLong(c.value)) return `A where value can be at most ${MAX_FILTER_VALUE_CHARS} characters.`;
  if (NEEDS_TEXT.has(op) && foldText(c.value) === '') {
    return `${op} requires a non-empty value`;
  }
  if (isNumberOp(op) && asNumber(c.value) === null) return `${op} requires a numeric value`;
  return null;
}

export interface WhereSheet {
  columns: readonly string[];
  // Run columns (AI, HTTP API, enrichment) → the column holding their run's state.
  runColumns: ReadonlyMap<string, string>;
}

const RUN_KINDS = 'AI, HTTP API or enrichment column';

// The `where` against the sheet: its columns exist, its values fit their
// operators, and run-state operators name run columns. null = fine.
export function checkWhere(where: readonly WhereItem[], sheet: WhereSheet): string | null {
  const conditions = whereConditions(where);
  // Every surface, MCP's schema-checked `where` included (parseWhere counts REST's).
  if (conditions.length > MAX_WHERE_CONDITIONS) return `where can hold at most ${MAX_WHERE_CONDITIONS} conditions.`;
  const known = new Set(sheet.columns);
  const unknown = conditions.map(c => c.column).filter((c): c is string => c !== undefined && !known.has(c));
  if (unknown.length) return `Unknown column(s): ${[...new Set(unknown)].join(', ')}`;
  for (const c of conditions) {
    const invalid = conditionValueError(c);
    if (invalid) return invalid;
    if (isStateOp(c.operator) && c.column !== undefined && !sheet.runColumns.has(c.column)) {
      return `"${c.column}" isn't an ${RUN_KINDS}, so it has no run state. Use ${c.operator} on one of those, `
        + 'or leave column out to check every run column.';
    }
  }
  return null;
}

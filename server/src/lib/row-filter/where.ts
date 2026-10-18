// A `where` (pure): which rows read_rows, REST rows/query, CSV export,
// transfer_rows and transform_column take, and the grid's filters (a view's
// three saved parts, lib/views/filters.ts). A list of items that must all
// pass. An item is a condition or a group: {"or": [items]} passes when any of
// its items does, {"and": [items]} when all do, and a group's items can be
// groups, MAX_WHERE_DEPTH deep. A condition with "enabled": false is off: it
// is kept (the grid shows it, a rename rewrites it) but no reader counts it,
// and a group left with nothing on counts for nothing either (activeWhere).
import {
  MAX_FILTER_LIST_VALUES, MAX_FILTER_VALUE_CHARS, MAX_WHERE_CONDITIONS, MAX_WHERE_DEPTH,
} from '../constants-filters';
import { asDate } from './dates';
import {
  FILTER_OPS, asNumber, foldText, isDateOp, isFilterOp, isListOp, isNumberOp, isStateOp, type FilterOp,
} from './ops';

export interface FilterCondition {
  // Optional for run-state operators only: left out, any run column.
  column?: string;
  operator: FilterOp;
  value?: string;
  values?: string[];
  // false: off. Only false is stored (on is the default).
  enabled?: false;
}
export interface OrGroup { or: WhereItem[] }
export interface AndGroup { and: WhereItem[] }
export type FilterGroup = OrGroup | AndGroup;
export type WhereItem = FilterCondition | FilterGroup;

export const isOrGroup = (item: WhereItem): item is OrGroup => 'or' in item;
export const isGroup = (item: WhereItem): item is FilterGroup => 'or' in item || 'and' in item;
export const groupItems = (group: FilterGroup): WhereItem[] => ('or' in group ? group.or : group.and);
// Every condition, inside groups too, off ones included.
export const whereConditions = (where: readonly WhereItem[]): FilterCondition[] =>
  where.flatMap(item => (isGroup(item) ? whereConditions(groupItems(item)) : [item]));

// The `where` readers filter by: off conditions dropped, then any group left
// empty (it no longer narrows anything). Off everywhere: [] (every row).
export function activeWhere(where: readonly WhereItem[]): WhereItem[] {
  const out: WhereItem[] = [];
  for (const item of where) {
    if (!isGroup(item)) {
      if (item.enabled !== false) out.push(item);
      continue;
    }
    const items = activeWhere(groupItems(item));
    if (items.length) out.push(isOrGroup(item) ? { or: items } : { and: items });
  }
  return out;
}

// A tool that changes rows (transfer_rows, transform_column) refuses a
// `where` with nothing on: it would pick every row without saying so.
export const allOffError = (where: readonly WhereItem[], every: string): string | null =>
  (where.length > 0 && activeWhere(where).length === 0
    ? `Every condition in where is turned off (enabled: false), which would pick every row. Turn one on, or ${every}.`
    : null);

const EXAMPLE = '{"column":"Status","operator":"eq","value":"Done"}';
const KEYS = ['column', 'operator', 'value', 'values', 'enabled'];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// One condition's shape: known keys and types only. "enabled": true is the
// default and isn't kept.
function conditionShape(raw: unknown): FilterCondition | string {
  if (!isObject(raw)) return `Each where condition is an object like ${EXAMPLE}.`;
  const extra = Object.keys(raw).filter(k => !KEYS.includes(k));
  if (extra.length) {
    return `Unknown key "${extra[0]}" in a where condition. A condition has column, operator, value or values, `
      + 'and enabled.';
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
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return 'enabled is true or false (false turns the condition off).';
  }
  const { enabled, ...condition } = raw;
  return (enabled === false ? { ...condition, enabled: false } : condition) as unknown as FilterCondition;
}

// One item, a group read with its items. depth: groups around it.
function itemShape(raw: unknown, depth: number, count: { n: number }): WhereItem | string {
  if (!isObject(raw) || !('or' in raw || 'and' in raw)) {
    const shaped = conditionShape(raw);
    if (typeof shaped !== 'string') count.n++;
    return shaped;
  }
  if ('or' in raw && 'and' in raw) return 'A group is {"or":[...]} or {"and":[...]}, not both: nest one in the other.';
  const key = 'or' in raw ? 'or' : 'and';
  const name = key.toUpperCase();
  if (Object.keys(raw).length !== 1) return `An ${name} group has only "${key}": {"${key}":[condition, ...]}.`;
  if (depth >= MAX_WHERE_DEPTH) return `Groups can sit inside groups at most ${MAX_WHERE_DEPTH} deep.`;
  const list = raw[key];
  if (!Array.isArray(list) || list.length === 0) {
    return `An ${name} group is {"${key}":[condition, ...]} with at least one condition or group.`;
  }
  const items: WhereItem[] = [];
  for (const item of list) {
    const shaped = itemShape(item, depth + 1, count);
    if (typeof shaped === 'string') return shaped;
    items.push(shaped);
  }
  return key === 'or' ? { or: items } : { and: items };
}

// The shape of a JSON `where` (REST bodies, stored link options, MCP's
// loosely typed groups via services/row-filter.ts prepareWhere). What the
// values mean is checked against the sheet by checkWhere.
export function parseWhere(raw: unknown): { where: WhereItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'where must be a non-empty list of conditions (and groups).' };
  }
  const where: WhereItem[] = [];
  const count = { n: 0 };
  for (const item of raw) {
    const shaped = itemShape(item, 0, count);
    if (typeof shaped === 'string') return { error: shaped };
    where.push(shaped);
  }
  if (count.n > MAX_WHERE_CONDITIONS) return { error: `where can hold at most ${MAX_WHERE_CONDITIONS} conditions.` };
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
  if (isDateOp(op) && asDate(c.value) === null) {
    return `${op} requires a date, like 2024-01-31 or Jan 31, 2024 ("${c.value}" isn't one).`;
  }
  return null;
}

export interface WhereSheet {
  columns: readonly string[];
  // Run columns (AI, HTTP API, enrichment) → the column holding their run's state.
  runColumns: ReadonlyMap<string, string>;
}

const RUN_KINDS = 'AI, HTTP API or enrichment column';

// The `where` against the sheet: its columns exist, its values fit their
// operators, and run-state operators name run columns. Off conditions are
// checked too: turning one on must not find it broken. null = fine.
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

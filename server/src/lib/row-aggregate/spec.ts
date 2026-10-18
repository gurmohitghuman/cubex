// An aggregate read (pure): read_rows' and REST rows/query's group_by and
// aggregates. Rows (those passing `where` and the view) are grouped by up to
// MAX_GROUP_BY_COLUMNS columns, values compared as text compares do (case and
// outer spaces ignored, like eq and any_of), and each group gets its row count
// plus the aggregates asked for. sum, avg, min and max read numbers the way gt
// and lt do (lib/row-filter/ops.ts asNumber: "1,000" counts, "N/A" is skipped);
// count with a column counts its non-empty cells.
import { MAX_AGGREGATES, MAX_GROUP_BY_COLUMNS } from '../constants-query';

export const AGGREGATE_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];

export interface Aggregate { op: AggregateOp; column?: string }
export interface AggregateSpec { groupBy: string[]; aggregates: Aggregate[] }

// The name an aggregate's value goes under: "count", "count(Email)", "sum(Revenue)".
export const aggregateName = (a: Aggregate): string => (a.column === undefined ? a.op : `${a.op}(${a.column})`);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const EXAMPLE = '{"op":"sum","column":"Revenue"}';

// The shape of group_by and aggregates (REST bodies; MCP's zod schema says the
// same). null = neither was given. Whether the columns exist is checkAggregate's.
export function parseAggregate(
  groupBy: unknown, aggregates: unknown,
): { spec: AggregateSpec | null } | { error: string } {
  if (groupBy === undefined && aggregates === undefined) return { spec: null };
  const by: string[] = [];
  if (groupBy !== undefined) {
    if (!Array.isArray(groupBy) || groupBy.length === 0 || groupBy.some(c => typeof c !== 'string' || !c)) {
      return { error: `group_by is a list of 1 to ${MAX_GROUP_BY_COLUMNS} column names.` };
    }
    if (groupBy.length > MAX_GROUP_BY_COLUMNS) {
      return { error: `group_by takes at most ${MAX_GROUP_BY_COLUMNS} columns.` };
    }
    if (new Set(groupBy).size !== groupBy.length) return { error: 'group_by names a column twice.' };
    by.push(...(groupBy as string[]));
  }
  const list: Aggregate[] = [];
  if (aggregates !== undefined) {
    if (!Array.isArray(aggregates) || aggregates.length === 0) {
      return { error: `aggregates is a list like [${EXAMPLE}].` };
    }
    if (aggregates.length > MAX_AGGREGATES) return { error: `aggregates takes at most ${MAX_AGGREGATES} items.` };
    for (const raw of aggregates) {
      if (!isObject(raw)) return { error: `Each aggregate is an object like ${EXAMPLE}.` };
      const extra = Object.keys(raw).find(k => k !== 'op' && k !== 'column');
      if (extra) return { error: `Unknown key "${extra}" in an aggregate. An aggregate has op and column.` };
      if (!(AGGREGATE_OPS as readonly unknown[]).includes(raw.op)) {
        return { error: `Unknown aggregate op "${String(raw.op)}". Use one of: ${AGGREGATE_OPS.join(', ')}.` };
      }
      if (raw.column !== undefined && (typeof raw.column !== 'string' || !raw.column)) {
        return { error: 'An aggregate column is a column name (text).' };
      }
      const a: Aggregate = { op: raw.op as AggregateOp, ...(raw.column !== undefined ? { column: raw.column } : {}) };
      if (a.op !== 'count' && a.column === undefined) return { error: `${a.op} needs a column, e.g. ${EXAMPLE}.` };
      if (list.some(b => aggregateName(b) === aggregateName(a))) {
        return { error: `${aggregateName(a)} is asked for twice.` };
      }
      list.push(a);
    }
  }
  return { spec: { groupBy: by, aggregates: list } };
}

// The columns it reads exist. null = fine.
export function checkAggregate(spec: AggregateSpec, columns: readonly string[]): string | null {
  const known = new Set(columns);
  const named = [...spec.groupBy, ...spec.aggregates.flatMap(a => (a.column === undefined ? [] : [a.column]))];
  const unknown = [...new Set(named.filter(c => !known.has(c)))];
  return unknown.length ? `Unknown column(s): ${unknown.join(', ')}` : null;
}

export const aggregateColumns = (spec: AggregateSpec): string[] =>
  [...new Set([...spec.groupBy, ...spec.aggregates.flatMap(a => (a.column === undefined ? [] : [a.column]))])];

// The grid's column filters (server: lib/row-filter, services/row-filter.ts):
// one per column, saved on the sheet, every one must pass. A value filter
// (text, number, date or list), an emptiness filter (sheets.empty_filter), or, on a
// column an AI, HTTP API or enrichment run fills, a run-state filter read from
// the words the run writes (❌, ⏳, ⏭️).
import type { ColumnType } from '@/utils/api/types'
import { MAX_FILTER_LIST_VALUES, MAX_FILTER_VALUE_CHARS } from './constants'

export type ValueFilterOp =
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'eq' | 'neq' | 'any_of' | 'not_any_of'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'date_eq' | 'date_neq' | 'date_lt' | 'date_lte' | 'date_gt' | 'date_gte'
export type RunStateOp = 'has_error' | 'has_result' | 'not_run' | 'condition_not_met' | 'running' | 'out_of_date'
export type FilterOp = ValueFilterOp | RunStateOp | 'empty' | 'not_empty'

export interface ColumnFilter { type: FilterOp; value?: string; values?: string[] }
export type ColumnFilters = Record<string, ColumnFilter>

export const VALUE_FILTERS: ReadonlyArray<{ op: ValueFilterOp; label: string }> = [
  { op: 'contains', label: 'Contains' },
  { op: 'not_contains', label: 'Does not contain' },
  { op: 'starts_with', label: 'Starts with' },
  { op: 'ends_with', label: 'Ends with' },
  { op: 'eq', label: 'Is' },
  { op: 'neq', label: 'Is not' },
  { op: 'any_of', label: 'Is any of' },
  { op: 'not_any_of', label: 'Is none of' },
  { op: 'gt', label: 'Greater than' },
  { op: 'gte', label: 'Greater than or equal' },
  { op: 'lt', label: 'Less than' },
  { op: 'lte', label: 'Less than or equal' },
  { op: 'date_eq', label: 'Date is' },
  { op: 'date_neq', label: 'Date is not' },
  { op: 'date_lt', label: 'Date is before' },
  { op: 'date_lte', label: 'Date is on or before' },
  { op: 'date_gt', label: 'Date is after' },
  { op: 'date_gte', label: 'Date is on or after' },
]

export const RUN_STATE_FILTERS: ReadonlyArray<{ op: RunStateOp; label: string }> = [
  { op: 'has_error', label: 'Rows with errors' },
  { op: 'has_result', label: 'Rows with a result' },
  { op: 'not_run', label: 'Rows not run yet' },
  { op: 'condition_not_met', label: 'Rows kept out by "Only run if"' },
  { op: 'running', label: 'Rows still running' },
  { op: 'out_of_date', label: 'Rows out of date (inputs changed)' },
]

// Columns a run fills: the ones run-state filters work on.
const RUN_COLUMN_TYPES = new Set<ColumnType>([
  'ai-output', 'ai-data', 'http-master', 'enrich-status', 'http-extracted', 'waterfall', 'waterfall-step',
])
export const isRunColumn = (type: ColumnType | undefined): boolean => !!type && RUN_COLUMN_TYPES.has(type)

export const isListFilter = (op: FilterOp): boolean => op === 'any_of' || op === 'not_any_of'
export const isNumberFilter = (op: FilterOp): boolean => op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte'
// Calendar days, in any format the server reads (lib/row-filter/dates.ts); the
// editors pick one as YYYY-MM-DD, and the server checks what's typed.
export const isDateFilter = (op: FilterOp): boolean => op.startsWith('date_')
export const isValueFilter = (op: FilterOp): op is ValueFilterOp => VALUE_FILTERS.some(f => f.op === op)
export const isRunStateFilter = (op: FilterOp): op is RunStateOp => RUN_STATE_FILTERS.some(f => f.op === op)

// A number the way the server reads one (lib/row-filter/ops.ts asNumber):
// commas only as thousands separators ("1,000", not "1,5").
const isNumber = (v: string): boolean => {
  let t = v.trim()
  if (t.includes(',')) {
    if (!/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return false
    t = t.replace(/,/g, '')
  }
  return t !== '' && Number.isFinite(Number(t))
}

// The filter a value editor's text makes (one value per line for a list), or
// null when the text is empty (no filter), or a message when it can't be one.
export function valueFilterFrom(op: ValueFilterOp, text: string): ColumnFilter | null | string {
  if (isListFilter(op)) {
    const values = [...new Set(text.split('\n').map(v => v.trim()).filter(Boolean))]
    if (values.length === 0) return null
    if (values.length > MAX_FILTER_LIST_VALUES) return `At most ${MAX_FILTER_LIST_VALUES} values.`
    if (values.some(v => v.length > MAX_FILTER_VALUE_CHARS)) {
      return `A value can be at most ${MAX_FILTER_VALUE_CHARS} characters.`
    }
    return { type: op, values }
  }
  const value = text.trim()
  if (!value) return null
  if (value.length > MAX_FILTER_VALUE_CHARS) return `A value can be at most ${MAX_FILTER_VALUE_CHARS} characters.`
  if (isNumberFilter(op) && !isNumber(value)) return 'Type a number, like 50 or 1,000.'
  if (isDateFilter(op) && !/\d/.test(value)) return 'Pick a date, or type one like 2024-01-31.'
  return { type: op, value }
}

// A server message about a condition with its operator's label for its id
// ("date_gt requires a date" reads "Date is after requires a date").
export function messageWithLabels(message: string): string {
  return message.replace(/^([a-z_]+) (requires|needs|takes|does not)/, (whole, op: string, rest: string) => {
    const label = VALUE_FILTERS.find(f => f.op === op)?.label
    return label ? `"${label}" ${rest}` : whole
  })
}

// The text a value editor shows for a saved filter.
export const filterText = (f: ColumnFilter | undefined): string => f?.values?.join('\n') ?? f?.value ?? ''

export const sameFilter = (a: ColumnFilter | null | undefined, b: ColumnFilter | null | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

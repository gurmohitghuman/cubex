// Saved views in the app (pure): what the active view hides, and its filter:
// the three parts the sheet keeps (empty_filter and column_filters, which the
// headers show, and row_filter, what they can't hold: a group, a run-state
// check on any run column, a condition turned off) as one `where`, and in words.
import type { SheetData } from '@/utils/api/types'
import type { WhereCondition, WhereItem } from '@/utils/api/views'
import { RUN_STATE_FILTERS, VALUE_FILTERS } from './filters'

export const activeViewOf = (data: SheetData | null) => data?.data.views?.find(v => v.active) ?? null

const parsed = <T>(raw: string | null | undefined, ok: (v: unknown) => boolean, fallback: T): T => {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw)
    return ok(v) ? v : fallback
  } catch {
    return fallback
  }
}
const isDict = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)

export const rowFilterOf = (data: SheetData | null): WhereItem[] =>
  parsed(data?.sheet.row_filter, Array.isArray, [])

// The active view's whole filter, in the order the server reads it (lib/views/filters.ts viewWhere).
export function sheetWhere(data: SheetData | null): WhereItem[] {
  const empty = parsed<Record<string, 'empty' | 'not_empty'>>(data?.sheet.empty_filter, isDict, {})
  const columns = parsed<Record<string, Omit<WhereCondition, 'column' | 'operator'> & { type: string }>>(
    data?.sheet.column_filters, isDict, {})
  return [
    ...Object.entries(empty).map(([column, operator]) => ({ column, operator })),
    ...Object.entries(columns).map(([column, { type, ...rest }]) =>
      ({ column, operator: type, ...rest }) as WhereCondition),
    ...rowFilterOf(data),
  ]
}

export const isGroupItem = (item: WhereItem): item is { or: WhereItem[] } | { and: WhereItem[] } =>
  'or' in item || 'and' in item
export const itemsOf = (group: { or: WhereItem[] } | { and: WhereItem[] }): WhereItem[] =>
  ('or' in group ? group.or : group.and)

// Conditions that count (on), inside groups too.
export const onConditions = (where: readonly WhereItem[]): WhereCondition[] =>
  where.flatMap(item => (isGroupItem(item) ? onConditions(itemsOf(item))
    : item.enabled === false ? [] : [item]))

const RUN_WORDS: Record<string, string> = {
  has_error: 'has an error', has_result: 'has a result', not_run: 'is not run yet',
  condition_not_met: 'is kept out by "Only run if"', running: 'is still running',
  out_of_date: 'is out of date (its inputs changed)',
}

function conditionWords(c: WhereCondition): string {
  const who = c.column ? `"${c.column}"` : 'Any AI, HTTP API or enrichment column'
  if (RUN_WORDS[c.operator]) return `${who} ${RUN_WORDS[c.operator]}`
  if (c.operator === 'empty') return `${who} is empty`
  if (c.operator === 'not_empty') return `${who} is not empty`
  const label = VALUE_FILTERS.find(f => f.op === c.operator)?.label.toLowerCase()
    ?? RUN_STATE_FILTERS.find(f => f.op === c.operator)?.label ?? c.operator
  const value = c.values ? c.values.join(', ') : c.value ?? ''
  return `${who} ${label} "${value}"`
}

// Items joined in words, off conditions left out ('' when none is on); a
// group of several inside another in brackets.
function itemsWords(items: readonly WhereItem[], join: 'and' | 'or'): string {
  return items.map(item => {
    if (!isGroupItem(item)) return item.enabled === false ? '' : conditionWords(item)
    const inner = itemsOf(item).map(i => itemsWords([i], 'and')).filter(Boolean)
    const words = itemsWords(itemsOf(item), 'or' in item ? 'or' : 'and')
    return inner.length > 1 ? `(${words})` : words
  }).filter(Boolean).join(` ${join} `)
}

// The whole filter in words; a filter that is one group reads without brackets.
export function whereWords(where: readonly WhereItem[]): string {
  if (where.length === 1 && isGroupItem(where[0])) {
    return itemsWords(itemsOf(where[0]), 'or' in where[0] ? 'or' : 'and')
  }
  return itemsWords(where, 'and')
}

// Whether the row_filter part has a rule that's on (the headers show the other parts).
export const rowFilterOn = (data: SheetData | null): boolean => onConditions(rowFilterOf(data)).length > 0

// Whether the view narrows the sheet: an export then asks "this view or the whole sheet?".
export const viewNarrows = (data: SheetData | null, hidden: readonly string[]): boolean =>
  onConditions(sheetWhere(data)).length > 0 || hidden.length > 0

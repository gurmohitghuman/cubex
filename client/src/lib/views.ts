// Saved views in the app (pure): what the active view hides, and its extra
// row filter (sheets.row_filter: what the per-column filters can't hold, such
// as "an error in any run column") in words for its chip.
import type { SheetData } from '@/utils/api/types'
import type { WhereCondition, WhereItem } from '@/utils/api/views'
import { RUN_STATE_FILTERS, VALUE_FILTERS } from './filters'

export const activeViewOf = (data: SheetData | null) => data?.data.views?.find(v => v.active) ?? null

export function rowFilterOf(data: SheetData | null): WhereItem[] {
  const raw = data?.sheet.row_filter
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

const RUN_WORDS: Record<string, string> = {
  has_error: 'has an error', has_result: 'has a result', not_run: 'is not run yet',
  condition_not_met: 'is kept out by "Only run if"', running: 'is still running',
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

export const rowFilterWords = (item: WhereItem): string =>
  'or' in item ? item.or.map(conditionWords).join(' or ') : conditionWords(item)

// Whether the view narrows the sheet: an export then asks "this view or the whole sheet?".
export function viewNarrows(data: SheetData | null, hidden: readonly string[]): boolean {
  const s = data?.sheet
  return !!(s?.empty_filter || s?.column_filters || s?.row_filter || hidden.length)
}

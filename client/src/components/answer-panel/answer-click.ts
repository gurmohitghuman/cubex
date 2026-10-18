// Which grid clicks open the answer panel (pure): a cell of an enrichment or
// HTTP API column (its status column or an output) that has a value and isn't
// still running (⏳). Other cells keep the grid's own behaviour.
import type { ColumnType } from '@/utils/api/types'

const ANSWER_COLUMNS = new Set<ColumnType>(['enrich-status', 'http-master', 'http-extracted'])

// A waterfall's cells open its trace instead (each step in turn).
const TRACE_COLUMNS = new Set<ColumnType>(['waterfall', 'waterfall-step'])

export function opensTrace(type: ColumnType | undefined, value: unknown): boolean {
  if (!type || !TRACE_COLUMNS.has(type)) return false
  return typeof value === 'string' && value.trim() !== '' && !value.includes('⏳')
}

export function opensAnswer(type: ColumnType | undefined, value: unknown): boolean {
  if (!type || !ANSWER_COLUMNS.has(type)) return false
  return typeof value === 'string' && value.trim() !== '' && !value.includes('⏳')
}

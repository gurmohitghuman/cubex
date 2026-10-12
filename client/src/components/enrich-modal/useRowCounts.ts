import { useEffect, useState } from 'react'
import { enrichAPI, type EnrichRowCounts } from '@/utils/api'
import type { Condition, RowsMode, RowsStatus } from './draft'

// Typing a condition's value re-counts once it settles.
const CONDITIONS_SETTLE_MS = 400

// Rows by status in an enrichment column a run already made, for the chosen
// scope: what "Rows not enriched yet (1,199)" and the Test step's "the other
// rows" count. With "Only run if" (conditions, a rule), only the rows passing
// them (also for a new column: total). Re-read when the scope, the column or the
// conditions change, and when `key` does (a run on the column ended). null
// while counting, or with neither a column nor conditions.
export function useRowCounts(
  sheetId: string, column: string | null, mode: RowsMode, selectedRows: number[], active: boolean, key = '',
  conditions: Condition[] = [], runIf = '',
): EnrichRowCounts | null {
  const [counts, setCounts] = useState<EnrichRowCounts | null>(null)
  const selection = mode === 'selected' ? selectedRows.join(',') : ''
  const where = JSON.stringify(conditions.map(c => ({ column: c.column, op: c.op, value: c.value })))
  const rule = runIf.trim()
  useEffect(() => {
    if (!active || (!column && conditions.length === 0 && !rule)) { setCounts(null); return }
    let alive = true
    setCounts(null)
    const timer = setTimeout(() => {
      const rows = mode === 'selected' ? selectedRows : undefined
      enrichAPI.rowCounts(sheetId, column, mode, rows, JSON.parse(where), rule)
        .then(c => { if (alive) setCounts(c) })
        .catch(() => {})
    }, conditions.length || rule ? CONDITIONS_SETTLE_MS : 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [sheetId, column, mode, selection, active, key, where, rule]) // eslint-disable-line react-hooks/exhaustive-deps
  return counts
}

export function countFor(counts: EnrichRowCounts | null, status: RowsStatus): number | null {
  if (!counts) return null
  if (status === 'not_enriched') return counts.notEnriched
  if (status === 'no_result') return counts.noResult
  if (status === 'failed') return counts.failed
  return counts.total
}

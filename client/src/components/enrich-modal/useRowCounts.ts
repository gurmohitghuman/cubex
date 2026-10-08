import { useEffect, useState } from 'react'
import { enrichAPI, type EnrichRowCounts } from '@/utils/api'
import type { RowsMode, RowsStatus } from './draft'

// Rows by status in an enrichment column a run already made, for the chosen
// scope: what "Rows not enriched yet (1,199)" and the Test step's "the other
// rows" count. Re-read when the scope or the column changes, and when `key`
// does (a run on the column ended). null while counting, or with no column.
export function useRowCounts(
  sheetId: string, column: string | null, mode: RowsMode, selectedRows: number[], active: boolean, key = '',
): EnrichRowCounts | null {
  const [counts, setCounts] = useState<EnrichRowCounts | null>(null)
  const selection = mode === 'selected' ? selectedRows.join(',') : ''
  useEffect(() => {
    if (!active || !column) { setCounts(null); return }
    let alive = true
    setCounts(null)
    enrichAPI.rowCounts(sheetId, column, mode, mode === 'selected' ? selectedRows : undefined)
      .then(c => { if (alive) setCounts(c) })
      .catch(() => {})
    return () => { alive = false }
  }, [sheetId, column, mode, selection, active, key]) // eslint-disable-line react-hooks/exhaustive-deps
  return counts
}

export function countFor(counts: EnrichRowCounts | null, status: RowsStatus): number | null {
  if (!counts) return null
  if (status === 'not_enriched') return counts.notEnriched
  if (status === 'no_result') return counts.noResult
  if (status === 'failed') return counts.failed
  return counts.total
}

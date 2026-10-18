import { useEffect, useState } from 'react'
import { runControlsAPI, type RunCounts } from '@/utils/api/run-controls'

// A run column's numbers for its menu (rows, empty, out of date, failed),
// read when the menu opens (sheetId undefined: not asked, e.g. while its run
// goes). null while counting, or when they can't be read (the sheet is busy):
// the items then show without numbers. A closed menu stops the count.
export function useRunColumnCounts(sheetId: string | undefined, column: string): RunCounts | null {
  const [counts, setCounts] = useState<RunCounts | null>(null)
  useEffect(() => {
    setCounts(null)
    if (!sheetId) return
    const ask = new AbortController()
    runControlsAPI.counts(sheetId, column, ask.signal)
      .then(c => { if (!ask.signal.aborted) setCounts(c) }).catch(() => {})
    return () => ask.abort()
  }, [sheetId, column])
  return counts
}

// How many rows an item takes, once counted (null while counting).
export const rowsFor = (c: RunCounts | null, rows: 'empty_or_out_of_date' | 'failed' | 'all'): number | null =>
  !c ? null : rows === 'empty_or_out_of_date' ? c.empty + c.outOfDate : rows === 'failed' ? c.failed : c.total

import { useEffect, useState } from 'react'
import { enrichAPI, settingsAPI, type EnrichReuseCount, type EnrichRunRequest } from '@/utils/api'

// Slower than the estimate: the count reads the rows the run takes.
const REUSE_DEBOUNCE_MS = 600

// What decides which rows reuse: the lookup and the rows, not the names, the
// outputs or the limits, so typing a column name doesn't count again (a new
// column's name only matters while it's valid: the draft asks only then).
function lookupKey(r: EnrichRunRequest): string {
  const { columnName, outputs: _outputs, maxCostPerRowUsd: _cap, spendLimitUsd: _limit, ...rest } = r
  return JSON.stringify({ ...rest, column: r.continueColumn ? columnName : null })
}

// How many rows of the run the draft would start reuse an answer an earlier
// run found, at no cost (the server checks them as the run would). null while
// unknown, for a run set to call every row again, and when the count failed:
// the estimate then prices every row, which is never too low.
export function useReuseCount(sheetId: string, request: EnrichRunRequest | null): EnrichReuseCount | null {
  const [count, setCount] = useState<EnrichReuseCount | null>(null)
  const key = request && !request.fresh ? lookupKey(request) : ''

  useEffect(() => {
    setCount(null)
    if (!key || !request) return
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      enrichAPI.reuseCount(sheetId, request, ctrl.signal)
        .then(next => { if (!ctrl.signal.aborted) setCount(next) })
        .catch(() => { /* priced as if every row calls */ })
    }, REUSE_DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [sheetId, key]) // eslint-disable-line react-hooks/exhaustive-deps

  return count
}

// The days found answers are reused for (Settings; 0: off), for the run
// dialog's "Always call again" note. null until read.
export function useReuseDays(active: boolean): number | null {
  const [days, setDays] = useState<number | null>(null)
  useEffect(() => {
    if (!active) return
    let live = true
    settingsAPI.getEnrichReuse().then(s => { if (live) setDays(s.days) }).catch(() => { /* note without days */ })
    return () => { live = false }
  }, [active])
  return days
}

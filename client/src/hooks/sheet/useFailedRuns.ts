// The header's "N failed, retry": failed rows per run column of the sheet
// (GET /api/run-controls/sheets/:id/failed, a walk over the whole sheet). Read a
// moment after the sheet opens and after `trigger` changes (a run starts or
// ends, rows go, a column is renamed), once however many changes come
// together (but at least every MAX_WAIT_MS while they keep coming, say auto-run
// batches a second apart); a newer read aborts the older one, whose walk the
// server then stops.
import { useCallback, useEffect, useRef, useState } from 'react'
import { runControlsAPI } from '@/utils/api/run-controls'

const SETTLE_MS = 1000
const MAX_WAIT_MS = 10_000
const BUSY_RETRY_MS = 3000

const sameCounts = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v)

export function useFailedRuns(sheetId: string | null, trigger: string) {
  const [failed, setFailed] = useState<Record<string, number>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const asking = useRef<AbortController | null>(null)
  // When the read now waiting was first asked for (null: none waits).
  const waitingSince = useRef<number | null>(null)

  // Read after `ms` (a later call moves it); busy (a sort or an import moving rows): once more later.
  const refresh = useCallback((ms = SETTLE_MS, retryBusy = true) => {
    clearTimeout(timer.current)
    if (!sheetId) return
    const now = Date.now()
    waitingSince.current ??= now
    const wait = Math.min(ms, Math.max(0, waitingSince.current + MAX_WAIT_MS - now))
    timer.current = setTimeout(() => {
      waitingSince.current = null
      asking.current?.abort()
      const ask = new AbortController()
      asking.current = ask
      runControlsAPI.failed(sheetId, ask.signal)
        .then(f => { if (asking.current === ask) setFailed(prev => (sameCounts(prev, f) ? prev : f)) })
        .catch(e => {
          if (asking.current === ask && retryBusy && e?.response?.data?.busy) refresh(BUSY_RETRY_MS, false)
        })
    }, wait)
  }, [sheetId])

  useEffect(() => {
    setFailed({})
    return () => { clearTimeout(timer.current); waitingSince.current = null; asking.current?.abort() }
  }, [sheetId])
  useEffect(() => { refresh() }, [refresh, trigger])

  // A retry just started on the column: its badge goes until the next read.
  const drop = useCallback((column: string) => setFailed(f => {
    if (!(column in f)) return f
    const next = { ...f }
    delete next[column]
    return next
  }), [])

  return { failed, refresh, drop }
}

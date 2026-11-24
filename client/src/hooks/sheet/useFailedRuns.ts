// The header's "N failed, retry": failed rows per run column of the sheet
// (GET /api/run-controls/sheets/:id/failed, a walk over the whole sheet). Read
// when the sheet opens and when `trigger` changes (a run starts or ends, rows
// go, a column is renamed), paced as the sheet's background reloads are
// (reloadPacer.ts): the first change after a quiet spell reads at once, then
// one read at a time, at most one a second and resting longer after a slow
// walk, so auto-run batches a second apart never stack up walks.
import { useCallback, useEffect, useRef, useState } from 'react'
import { runControlsAPI } from '@/utils/api/run-controls'
import { ReloadPacer } from './reloadPacer'

const BUSY_RETRY_MS = 3000

const sameCounts = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v)

export function useFailedRuns(sheetId: string | null, trigger: string) {
  const [failed, setFailed] = useState<Record<string, number>>({})
  const pacer = useRef<ReloadPacer | null>(null)
  // A read asked for later: after a start, or once more after a busy answer.
  const later = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    setFailed({})
    if (!sheetId) return
    const ctl = new AbortController()
    let retriedBusy = false
    const own = new ReloadPacer(async id => {
      try {
        const f = await runControlsAPI.failed(id, ctl.signal)
        retriedBusy = false
        if (!ctl.signal.aborted) setFailed(prev => (sameCounts(prev, f) ? prev : f))
      } catch (e: any) {
        // Busy (a sort or an import moving rows): once more later.
        if (ctl.signal.aborted || !e?.response?.data?.busy || retriedBusy) return
        retriedBusy = true
        clearTimeout(later.current)
        later.current = setTimeout(() => own.request(id), BUSY_RETRY_MS)
      }
    })
    pacer.current = own
    return () => {
      own.stop()
      ctl.abort()
      clearTimeout(later.current)
      if (pacer.current === own) pacer.current = null
    }
  }, [sheetId])

  // Read now (paced), or after `ms` (a run that may end before the active runs list shows it).
  const refresh = useCallback((ms = 0) => {
    if (!sheetId) return
    if (ms <= 0) { pacer.current?.request(sheetId); return }
    clearTimeout(later.current)
    later.current = setTimeout(() => pacer.current?.request(sheetId), ms)
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

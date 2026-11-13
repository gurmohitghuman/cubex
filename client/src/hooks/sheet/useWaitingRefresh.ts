import { useEffect } from 'react'
import type { AIRun, HTTPRun } from '@/utils/api'
import { WAITING_REFRESH_MS } from '@/lib/constants'

// The waiting notice (components/sheet/WaitingRunsNotice.tsx) follows the server's words: a run that waits sends
// no progress, and one that parks or whose holder pauses sends nothing either. So while a listed run is pending
// (queued, or parked behind another run) or says it waits, the sheet's run lists are read again this often.
export function useWaitingRefresh(sheetId: string | null, aiRuns: AIRun[], httpRuns: HTTPRun[],
  refetch: (sheetId: string) => unknown): void {
  const watch = [...aiRuns, ...httpRuns].some(r => r.status === 'pending' || !!r.waiting)
  useEffect(() => {
    if (!sheetId || !watch) return
    const t = setInterval(() => { void refetch(sheetId) }, WAITING_REFRESH_MS)
    return () => clearInterval(t)
  }, [sheetId, watch, refetch])
}

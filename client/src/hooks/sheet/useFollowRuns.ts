import { useRef } from 'react'
import type { AIRun, HTTPRun } from '@/utils/api'
import type { ActiveRunRef } from './useSheetChangePoll'

// Follows runs this tab didn't start (an auto-run, another tab's run, an
// agent's): the change poll names the sheet's active runs, and any not yet
// known here gets its stream opened and the run lists refreshed, so its cells
// paint live without a reload.
export function useFollowRuns(a: {
  httpRuns: HTTPRun[]
  aiRuns: AIRun[]
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  refetchRuns: (sheetId: string) => unknown
}) {
  const ref = useRef(a)
  ref.current = a
  return (sheetId: string, runs: ActiveRunRef[]) => {
    const { httpRuns, aiRuns, setupSSEConnection, refetchRuns } = ref.current
    const known = new Set([...httpRuns.map(r => r.id), ...aiRuns.map(r => r.id)])
    const fresh = runs.filter(r => !known.has(r.id))
    if (fresh.length === 0) return
    for (const r of fresh) void setupSSEConnection(r.id, r.kind)
    void refetchRuns(sheetId)
  }
}

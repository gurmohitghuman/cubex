import { useCallback, useEffect, useRef, useState } from 'react'
import { AIRun, HTTPRun, Sheet, SheetData } from '@/utils/api'
import { reconnectActiveRuns, enqueueResultEvent, handleTerminalStatus, toastRunFailure } from './sseHelpers'
import { createSSEResultBuffer, type SSEResultBuffer } from './sseResultBuffer'

interface UseSheetSSEArgs {
  activeSheet: Sheet | null
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>
  setActiveAIRunsList: (runs: AIRun[]) => void
  setActiveHTTPRuns: (runs: HTTPRun[]) => void
  fetchActiveHTTPRuns: (sheetId: string) => Promise<HTTPRun[]> | void
  fetchActiveAIRuns: (sheetId: string) => Promise<AIRun[]> | void
  reloadSheet: (sheetId: string) => void | Promise<void>
  currentSheetIdRef: React.MutableRefObject<string | null>
}

export const useSheetSSE = ({
  activeSheet, setSheetData, setIsLoading,
  setActiveAIRunsList, setActiveHTTPRuns,
  fetchActiveHTTPRuns, fetchActiveAIRuns,
  reloadSheet, currentSheetIdRef,
}: UseSheetSSEArgs) => {
  const sseRef = useRef<Map<string, EventSource>>(new Map())
  // Deliberate-reconnect budget per run (see onerror below). Reset whenever a
  // stream delivers a message, so a healthy long run never exhausts it.
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map())
  // Runs already seen terminal (completed/failed/cancelled). The server ends a
  // terminal stream, which reaches EventSource as onerror — indistinguishable
  // from a network blip. Without this, that end-of-stream triggers up-to-5
  // reconnects, each replaying old results over the user's edits. onerror
  // consults this and skips reconnect; setupSSEConnection clears it on (re)open.
  const terminalRunsRef = useRef<Set<string>>(new Set())
  // runId → the sheetId it belongs to, captured at stream open. Result events
  // carry no sheetId, and a stream opened on sheet A keeps delivering after a
  // switch to B (switch doesn't close streams) — so without this it paints A's
  // outputs into B's same-named cells. handleSSEMessage skips the live paint when
  // bound sheet ≠ active; the result is persisted, so it shows on reload of A.
  const runSheetRef = useRef<Map<string, string>>(new Map())
  // Throttle gate for progress-driven run-list refetches. A saturated run emits
  // a 'progress' event every ~400ms; refetching active runs on each one fired up
  // to ~5 GETs/sec, which exhausted the global 1000/15min limiter in minutes and
  // then 429'd autosave (silent edit loss). The header pill shows only
  // presence/running state and the per-column badges only status — neither
  // changes on a progress tick — so throttling to once per 5s is ample to catch
  // a status drift (pause/resume) without the flood.
  const lastRunsRefetchRef = useRef(0)
  const PROGRESS_REFETCH_THROTTLE_MS = 5000
  // Self-reference for the reconnect timeout — setupSSEConnection can't call
  // itself from inside its own useCallback body.
  const setupRef = useRef<(runId: string, type?: 'ai' | 'http') => void>(() => {})
  // Pending reload/reconnect setTimeout IDs. Tracked so unmount cleanup can clear
  // them — otherwise a timer scheduled during a connection blip outlives the
  // component and fires against an unmounted/different sheet (orphan EventSource
  // or a reloadSheet on a sheet the user has navigated away from). The
  // currentSheetIdRef guards inside each timer don't cover the unmounted case.
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const [_activeAIRuns, setActiveAIRuns] = useState<Set<string>>(new Set())

  // Coalescing buffer for SSE 'result' events (perf fix #1 — see sseResultBuffer):
  // events queue and flush once per frame, replacing the old per-event full-array copy.
  const bufferRef = useRef<SSEResultBuffer | null>(null)
  if (!bufferRef.current) {
    bufferRef.current = createSSEResultBuffer(setSheetData)
  }

  const handleSSEMessage = useCallback((data: any, runId: string) => {
    const currentSheetId = currentSheetIdRef.current
    // Sheet this run belongs to (see runSheetRef). undefined = legacy stream →
    // fall back to active-sheet behavior.
    const runSheetId = runSheetRef.current.get(runId)

    if (data.type === 'result' && currentSheetId && (runSheetId === undefined || runSheetId === currentSheetId)) {
      enqueueResultEvent(data, bufferRef.current!)
    } else if (data.type === 'status' && (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') && currentSheetId) {
      // 'cancelled' MUST be terminal here (server ends cancelled/completed/failed
      // streams; end-of-stream → onerror → reconnect that replays old results over
      // edits — handleTerminalStatus closes it). Flush any buffered results FIRST so
      // an in-flight batch can't repaint over the fresher post-run silent reload.
      bufferRef.current!.flushNow()
      handleTerminalStatus(data, runId, currentSheetId, runSheetId, {
        sseRef, reconnectAttemptsRef, terminalRunsRef, runSheetRef, pendingTimersRef,
        currentSheetIdRef, setActiveAIRuns, fetchActiveHTTPRuns, fetchActiveAIRuns, reloadSheet,
      })
      // Only a genuine failure toasts ('cancelled' is deliberate → no lie).
      if (data.status === 'failed') toastRunFailure(data)
    } else if (data.type === 'progress' && currentSheetId) {
      // Throttled — see lastRunsRefetchRef. Without this, a long run self-trips
      // the global rate limiter and autosave starts 429ing (silent edit loss).
      const now = Date.now()
      if (now - lastRunsRefetchRef.current >= PROGRESS_REFETCH_THROTTLE_MS) {
        lastRunsRefetchRef.current = now
        fetchActiveHTTPRuns(currentSheetId); fetchActiveAIRuns(currentSheetId)
      }
    }
  }, [reloadSheet, fetchActiveHTTPRuns, fetchActiveAIRuns, currentSheetIdRef])

  const setupSSEConnection = useCallback(async (runId: string, type: 'ai' | 'http' = 'ai') => {
    if (sseRef.current.has(runId)) return
    // Fresh deliberate open: a terminal run never reaches here (onerror returns
    // early for it, and reconnectToActiveRuns only opens server-reported-active
    // runs). So if we ARE opening, this id is live again — clear any stale
    // terminal flag so a re-run reusing the id isn't permanently blocked.
    terminalRunsRef.current.delete(runId)
    // Bind run→sheet at open (every open site has currentSheetIdRef = the run's
    // sheet). set-if-absent so a transient-blip reconnect never rebinds it.
    const openSheetId = currentSheetIdRef.current
    if (openSheetId && !runSheetRef.current.has(runId)) runSheetRef.current.set(runId, openSheetId)
    const endpoint = type === 'ai' ? `ai/runs/${runId}/stream` : `http/jobs/${runId}/stream`
    const eventSource = new EventSource(`/api/${endpoint}`, { withCredentials: true })

    eventSource.onmessage = (event) => {
      // Healthy stream — restore the full reconnect budget.
      reconnectAttemptsRef.current.delete(runId)
      try { handleSSEMessage(JSON.parse(event.data), runId) }
      catch (error) { console.error('Failed to parse SSE message:', error) }
    }
    eventSource.onerror = (error) => {
      console.error('SSE connection error for run:', runId, error)
      // close() is load-bearing: EventSource AUTO-RECONNECTS after errors, so
      // merely dropping our reference left an untracked immortal connection
      // (the unmount cleanup and terminal-status close only see the map) that
      // ate the per-user SSE budget — and a later reconnectToActiveRuns
      // opened a DUPLICATE. Close it, then reconnect deliberately, bounded.
      eventSource.close()
      sseRef.current.delete(runId)
      setActiveAIRuns(prev => { const next = new Set(prev); next.delete(runId); return next })
      // A run we've already seen go terminal ended its own stream — this onerror
      // is the expected end-of-stream, NOT a network blip. Don't reconnect, or we
      // loop and replay old results over the user's edits.
      if (terminalRunsRef.current.has(runId)) return
      const attempts = (reconnectAttemptsRef.current.get(runId) || 0) + 1
      reconnectAttemptsRef.current.set(runId, attempts)
      // 5 strikes covers transient blips and the server's max-lifetime stream
      // close; a run that's gone (404s every attempt) stops retrying instead
      // of looping forever. The budget resets on any received message.
      if (attempts <= 5) {
        const timer = setTimeout(() => {
          pendingTimersRef.current.delete(timer)
          // Re-check terminal AT FIRE TIME: the run can go terminal during the 2s
          // wait, and reopening a finished run's stream just to have the server end
          // it again is wasteful + briefly re-marks it active. No `=== boundSheet`
          // guard (unlike the reload timer) — reconnecting a background run while on
          // another sheet is intended; runSheetRef stops its wrong-sheet painting.
          if (terminalRunsRef.current.has(runId)) return
          if (currentSheetIdRef.current) setupRef.current(runId, type)
        }, 2000)
        pendingTimersRef.current.add(timer)
      }
    }

    sseRef.current.set(runId, eventSource)
    setActiveAIRuns(prev => { const next = new Set(prev); next.add(runId); return next })
  }, [handleSSEMessage, currentSheetIdRef])

  // Keep the self-reference fresh for the reconnect timeout.
  setupRef.current = setupSSEConnection

  const reconnectToActiveRuns = useCallback(async (sheetId: string) => {
    await reconnectActiveRuns({
      sheetId,
      setActiveAIRuns: setActiveAIRunsList,
      setActiveHTTPRuns,
      setupSSEConnection,
    })
  }, [setupSSEConnection, setActiveAIRunsList, setActiveHTTPRuns])

  useEffect(() => {
    return () => {
      sseRef.current.forEach(connection => connection.close())
      // Clear pending reload/reconnect timers, or they fire post-unmount against a
      // stale sheet (orphan EventSource / wrong-sheet reload). Drop buffered deltas too.
      pendingTimersRef.current.forEach(clearTimeout)
      pendingTimersRef.current.clear()
      bufferRef.current?.reset()
      setIsLoading(false)
    }
  }, [setIsLoading])

  // Reset the buffer on active-sheet change: SheetPage stays mounted across in-app
  // switches, so a flush scheduled from sheet A could otherwise fire after the switch
  // and patch A's values into B. Pending work is gated by runSheetRef → only ever the
  // old sheet's, safe to drop (results are persisted + reloaded).
  useEffect(() => { bufferRef.current?.reset() }, [activeSheet?.id])

  void _activeAIRuns

  return {
    setupSSEConnection,
    reconnectToActiveRuns,
  }
}

// Stateless helpers for SSE reconnection and result events.
// Extracted from useSheetSSE so the hook file stays under the 200-line cap.

import toast from 'react-hot-toast'
import { AIRun, HTTPRun } from '@/utils/api'
import { SSEResultBuffer, deriveAICellValue } from './sseResultBuffer'

// Enqueue an SSE 'result' delta (AI single-column OR HTTP extractedFields) into the
// coalescing buffer (perf fix #1). The CALLER decides whether this result belongs to
// the active sheet (run→sheet binding); this just queues once that's been cleared.
export const enqueueResultEvent = (data: any, buffer: SSEResultBuffer) => {
  if (data.columnName) {
    const value = deriveAICellValue(data.status, data.outputValue, data.errorMessage)
    buffer.enqueueCell(data.rowIndex, data.columnName, value)
  } else if (data.extractedFields) {
    // HTTP runs: data.extractedFields is a map of the EXACT final cell strings the
    // server already computed (field values, or markers like '❌ Error' / '⏭️ No
    // data' / '✅ Success' — see httpResultCellValues). Queue them VERBATIM — do NOT
    // re-derive status, or a failed row's precise '❌ Error'/'❌ Failed' marker gets
    // overwritten and the live cell differs from what a reload shows.
    // The server now sends a value for EVERY mapping column (httpResultCellValues
    // iterates the full mapping list and emits '⏭️ No data' for any empty/null
    // field, not just the ones that matched), so a partial-match row clears the
    // '⏳ Processing...' placeholder on every cell live — matching the reload value.
    // The nullish guard below is just belt-and-suspenders for an unexpected raw
    // null; an extracted-but-empty HTTP field is empty, NOT "processing".
    Object.entries(data.extractedFields).forEach(([columnName, value]) => {
      buffer.enqueueCell(data.rowIndex, columnName, value === undefined || value === null ? '' : String(value))
    })
  }
}

// Toast a failed run's redacted reason. Clamp defensively: the server bounds new
// error_message writes to 500, but a legacy/manual value could be arbitrarily long
// and blow out the toast — trim + cap, default for empty/whitespace.
export const toastRunFailure = (data: any) => {
  const raw = (data.error || '').trim()
  const reason = raw ? (raw.length > 300 ? `${raw.slice(0, 300)}…` : raw) : 'Unknown error'
  toast.error(`Processing failed: ${reason}`)
}

// Progress ticks refetch the active runs at most once per 5 s (see
// lastRunsRefetchRef in useSheetSSE): every tick would trip the global rate
// limiter and 429 autosave.
const PROGRESS_REFETCH_THROTTLE_MS = 5000
export const refetchRunsThrottled = (lastRef: React.MutableRefObject<number>, refetch: () => void) => {
  const now = Date.now()
  if (now - lastRef.current < PROGRESS_REFETCH_THROTTLE_MS) return
  lastRef.current = now
  refetch()
}

// A run that paused itself (an enrichment's spend or daily limit, the treg
// balance or key, treg unreachable) says why; a pause the user clicked doesn't.
// An enrichment's pause goes to `onEnrichPaused`, which offers its fix (the
// drawer's Run step) or stays quiet when the drawer already shows it.
export const notePausedRun = (
  data: any, runId: string, refetch: () => void, onEnrichPaused?: (runId: string, reason: string) => void,
) => {
  refetch()
  const raw = (data.error || '').trim()
  if (!raw) return
  const reason = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
  if (data.enrichment && onEnrichPaused) onEnrichPaused(runId, reason)
  else toast.error(`Paused: ${reason}`)
}

// Refs/setters/callbacks handleTerminalStatus needs. Bundled so the hook passes
// one object instead of a long arg list.
export interface TerminalStatusCtx {
  sseRef: React.MutableRefObject<Map<string, EventSource>>
  reconnectAttemptsRef: React.MutableRefObject<Map<string, number>>
  terminalRunsRef: React.MutableRefObject<Set<string>>
  runSheetRef: React.MutableRefObject<Map<string, string>>
  pendingTimersRef: React.MutableRefObject<Set<ReturnType<typeof setTimeout>>>
  currentSheetIdRef: React.MutableRefObject<string | null>
  setActiveAIRuns: React.Dispatch<React.SetStateAction<Set<string>>>
  fetchActiveHTTPRuns: (sheetId: string) => unknown
  fetchActiveAIRuns: (sheetId: string) => unknown
  reloadSheet: (sheetId: string) => void | Promise<void>
}

// Handle a terminal ('completed'/'failed'/'cancelled') run-status SSE event:
// tear the stream down, clear per-run bookkeeping, refresh the active sheet's
// run-list metadata, and schedule a one-shot reload of the run's OWN sheet (only
// if it's still active at fire time). The returned timer is registered in
// pendingTimersRef so unmount cleanup can cancel it. Why each close/terminal
// step is load-bearing is documented at the call site in useSheetSSE.
export const handleTerminalStatus = (
  data: any, runId: string, currentSheetId: string, runSheetId: string | undefined,
  ctx: TerminalStatusCtx,
) => {
  // Mark terminal BEFORE close() so the onerror that close() triggers sees it
  // and declines to reconnect (otherwise the end-of-stream replays results).
  ctx.terminalRunsRef.current.add(runId)
  const connection = ctx.sseRef.current.get(runId)
  if (connection) {
    connection.close()
    ctx.sseRef.current.delete(runId)
  }
  ctx.reconnectAttemptsRef.current.delete(runId)
  ctx.runSheetRef.current.delete(runId)
  ctx.setActiveAIRuns(prev => { const next = new Set(prev); next.delete(runId); return next })
  // Run-list metadata (header pill / column badges) for the active sheet.
  ctx.fetchActiveHTTPRuns(currentSheetId); ctx.fetchActiveAIRuns(currentSheetId)
  // Reload only the run's OWN sheet, and only if it's still the active one at
  // fire time, so a background-sheet run completing can't discard the active
  // sheet's in-flight load. runSheetId falls back for a legacy pre-binding stream.
  const reloadTarget = runSheetId ?? currentSheetId
  const timer = setTimeout(() => {
    ctx.pendingTimersRef.current.delete(timer)
    if (ctx.currentSheetIdRef.current === reloadTarget) ctx.reloadSheet(reloadTarget)
  }, 1000)
  ctx.pendingTimersRef.current.add(timer)
}

const ACTIVE = new Set(['running', 'paused', 'pending'])

interface ReconnectArgs {
  sheetId: string
  setActiveAIRuns: (runs: AIRun[]) => void
  setActiveHTTPRuns: (runs: HTTPRun[]) => void
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => unknown
}

export const reconnectActiveRuns = async ({
  sheetId, setActiveAIRuns, setActiveHTTPRuns, setupSSEConnection,
}: ReconnectArgs) => {
  try {
    const aiResponse = await fetch(`/api/ai/runs?sheetId=${sheetId}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (aiResponse.ok) {
      const aiRuns = await aiResponse.json()
      const active = aiRuns.filter((run: any) => ACTIVE.has(run.status))
      setActiveAIRuns(active)
      for (const run of active) setupSSEConnection(run.id, 'ai')
    }
  } catch (error) {
    console.error('Error fetching AI runs for reconnection:', error)
  }

  try {
    const httpResponse = await fetch(`/api/http/runs?sheetId=${sheetId}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (httpResponse.ok) {
      const httpRuns = await httpResponse.json()
      const active = httpRuns.filter((run: any) => ACTIVE.has(run.status))
      setActiveHTTPRuns(active)
      for (const run of active) setupSSEConnection(run.id, 'http')
    }
  } catch (error) {
    console.error('Error fetching HTTP runs for reconnection:', error)
  }
}

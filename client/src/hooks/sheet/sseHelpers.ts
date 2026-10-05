// Stateless helpers for SSE reconnection and AI-results bootstrap.
// Extracted from useSheetSSE so the hook file stays under the 200-line cap.

import toast from 'react-hot-toast'
import { AIRun, HTTPRun } from '@/utils/api'
import { SSEResultBuffer, deriveAICellValue } from './sseResultBuffer'

export const fetchExistingAIResults = async (sheetId: string): Promise<Map<string, string>> => {
  const map = new Map<string, string>()
  try {
    const response = await fetch(`/api/ai/sheets/${sheetId}/results`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok) {
      console.error('Failed to fetch AI results for sheet:', response.status, response.statusText)
      return map
    }
    const results = await response.json()
    for (const result of results) {
      const cellKey = `${result.row_index}:${result.column_name}`
      map.set(cellKey, result.id)
      // Mirror the (Output) cell's resultId onto the (Data) sibling so clicks on
      // either reach the scraped-data modal via the same lookup.
      if (result.column_name.endsWith(' (Output)')) {
        const dataKey = `${result.row_index}:${result.column_name.replace(' (Output)', ' (Data)')}`
        map.set(dataKey, result.id)
      }
    }
  } catch (error) {
    console.error('Error loading existing AI results:', error)
  }
  return map
}

// The aiResultCells keys a completed AI result is recorded under (so a cell click
// opens the scraped-data modal): the (row:column) key plus, for an (Output)
// column, its (Data) sibling — the modal is reachable from either. Must match the
// colon-keyed format fetchExistingAIResults seeds.
export const withAIResultIdKeys = (rowIndex: number, columnName: string): string[] => {
  const keys = [`${rowIndex}:${columnName}`]
  if (columnName.endsWith(' (Output)')) {
    keys.push(`${rowIndex}:${columnName.replace(' (Output)', ' (Data)')}`)
  }
  return keys
}

// Enqueue an SSE 'result' delta (AI single-column OR HTTP extractedFields) into the
// coalescing buffer (perf fix #1). The CALLER decides whether this result belongs to
// the active sheet (run→sheet binding); this just queues once that's been cleared.
export const enqueueResultEvent = (data: any, buffer: SSEResultBuffer) => {
  if (data.columnName) {
    buffer.enqueueCell(data.rowIndex, data.columnName, deriveAICellValue(data.status, data.outputValue, data.errorMessage))
    if (data.status === 'completed' && data.resultId) {
      buffer.enqueueResultId(data.rowIndex, data.columnName, data.resultId)
    }
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
      const active = aiRuns.filter((run: any) => run.status === 'running' || run.status === 'paused' || run.status === 'pending')
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
      const active = httpRuns.filter((run: any) => run.status === 'running' || run.status === 'paused' || run.status === 'pending')
      setActiveHTTPRuns(active)
      for (const run of active) setupSSEConnection(run.id, 'http')
    }
  } catch (error) {
    console.error('Error fetching HTTP runs for reconnection:', error)
  }
}

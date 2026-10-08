import React from 'react'
import toast from 'react-hot-toast'
import { aiAPI, httpAPI, AIRun, HTTPRun, Sheet } from '@/utils/api'
import { structuredRunOwns } from '@/lib/structuredRuns'
import { useAIColumnRunActions } from './useAIColumnRunActions'
import { useHTTPColumnRunActions } from './useHTTPColumnRunActions'

export interface GridRunArgs {
  activeSheet: Sheet | null
  activeAIRunsList: AIRun[]
  activeHTTPRuns: HTTPRun[]
  setShowAddColumnModal: (open: boolean) => void
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  fetchActiveHTTPRuns: (sheetId: string) => unknown
  fetchActiveAIRuns: (sheetId: string) => unknown
  reloadSheetData?: (sheetId: string) => unknown
  // Per-sheet row_generation the tab loaded at. Sent with a "Run Selected Rows"
  // rerun so the server 409s if a sort/CSV-replace elsewhere re-meant the indices
  // (migration 021 fence). Optional: omitted → server skips the check.
  rowGenerationRef?: React.MutableRefObject<Map<string, number>>
}

// The grid's run actions from the column menu: the AI and HTTP blocks' own
// hooks, plus stopping a column's run and deleting a column.
export const useSheetGridRunActions = (a: GridRunArgs) => {
  const ai = useAIColumnRunActions(a)
  const http = useHTTPColumnRunActions(a)

  const handleStopRunForColumn = (type: 'ai' | 'http', columnName: string) => {
    if (!a.activeSheet) return
    // Reload sheet cells after cancel — server clears '⏳ Processing...'
    // placeholders for unprocessed rows; without a reload the grid keeps
    // rendering "Loading...".
    const afterCancel = () => {
      a.fetchActiveHTTPRuns(a.activeSheet!.id)
      a.fetchActiveAIRuns(a.activeSheet!.id)
      a.reloadSheetData?.(a.activeSheet!.id)
    }
    if (type === 'http') {
      const run = a.activeHTTPRuns.find(r => r.master_column_name === columnName)
      if (run) {
        httpAPI.controlRun(run.id, 'cancel')
          .then(afterCancel)
          .catch(e => toast.error(e.response?.data?.error || 'Failed to cancel HTTP API run'))
      }
    } else {
      // A structured run is stopped from any of its columns.
      const run = a.activeAIRunsList.find(r => r.column_name === columnName || structuredRunOwns(r, columnName))
      if (run) {
        aiAPI.cancelRun(run.id)
          .then(afterCancel)
          .catch(e => toast.error(e.response?.data?.error || 'Failed to cancel AI run'))
      }
    }
  }

  const handleDeleteColumnWithWidthCleanup = async (
    col: string,
    onDeleteColumn: (columnName: string) => void | Promise<void>,
  ) => {
    if (!a.activeSheet) return
    // Just delete. Width cleanup is now automatic: useColumnWidths prunes width
    // entries for columns no longer in the live `columns` list (in STATE, then
    // persisted by its save effect). Writing localStorage directly here was a
    // second writer that the next resize's save effect would clobber from stale
    // state — the same divergence this fix removes. Don't reintroduce it.
    await onDeleteColumn(col)
  }

  return {
    ...ai,
    ...http,
    handleStopRunForColumn,
    handleDeleteColumnWithWidthCleanup,
  }
}

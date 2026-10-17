import toast from 'react-hot-toast'
import { httpAPI } from '@/utils/api'
import { plural } from '@/lib/utils'
import type { GridRunArgs } from './useSheetGridRunActions'

// The column menu's HTTP API Actions: run all rows, run missing or errors, run
// the first rows, and run the selected rows, each a rerun on the column. Split out of
// useSheetGridRunActions. Enrichment columns have their own (useEnrichColumnActions).
const rerunning = (n: number) => `Re-running HTTP for ${plural(n, 'row')}`

export const useHTTPColumnRunActions = (a: GridRunArgs) => {
  // HTTP rerun mirrors the AI rerun handlers: start a row-subset run on an
  // existing master column, open SSE, refresh active runs so the header
  // Pause/Stop pill appears immediately (don't wait on the ~5s SSE throttle).
  const startHTTPRerun = async (
    masterColumnName: string,
    opts: { mode?: 'missing'; rowIndices?: number[]; firstRows?: number },
    successMsg: (targetRows: number) => string,
    errorMsg: string,
  ) => {
    if (!a.activeSheet) return
    try {
      // For a rowIndices selection, send the LIVE row_generation (from
      // rowGenerationRef, seeded from sheetData on every load) so the server 409s
      // if a sort/CSV-replace re-meant the indices since selection (P2-5). NOT
      // activeSheet.row_generation — that's table-list metadata that doesn't
      // refresh after a same-tab sort, so it would spuriously 409 a valid rerun.
      const rowGeneration = opts.rowIndices && opts.rowIndices.length > 0
        ? a.rowGenerationRef?.current.get(a.activeSheet.id)
        : undefined
      const res = await httpAPI.rerun(a.activeSheet.id, masterColumnName, { ...opts, rowGeneration })
      toast.success(successMsg(res.targetRows))
      a.setupSSEConnection(res.runId, 'http')
      a.fetchActiveHTTPRuns(a.activeSheet.id)
      // Silent reload so placeholders show + reconnectToActiveRuns re-attaches SSE.
      // See handleRunAIForColumn.
      a.reloadSheetData?.(a.activeSheet.id)
    } catch (e: any) {
      console.error('HTTP rerun error:', e)
      toast.error(e.response?.data?.error || errorMsg)
    }
  }

  const handleRunHTTPForColumn = (masterColumnName: string) =>
    startHTTPRerun(masterColumnName, {}, rerunning, 'Failed to start HTTP run')

  const handleRunHTTPMissingOrError = (masterColumnName: string) =>
    startHTTPRerun(masterColumnName, { mode: 'missing' }, rerunning, 'Failed to re-run HTTP')

  // Batched: the menu hands us all selected row indices at once (one run for the
  // whole selection), not one run per row — N runs would trip the concurrency cap.
  const handleRunHTTPForRows = (masterColumnName: string, rowIndices: number[]) => {
    if (rowIndices.length === 0) return
    return startHTTPRerun(masterColumnName, { rowIndices }, rerunning, 'Failed to re-run HTTP')
  }

  // "Run First Rows": every one of the sheet's top rows again (a test before a big run).
  const handleRunHTTPFirstRows = (masterColumnName: string, firstRows: number) =>
    startHTTPRerun(masterColumnName, { firstRows }, rerunning, 'Failed to run HTTP')

  return { handleRunHTTPForColumn, handleRunHTTPMissingOrError, handleRunHTTPForRows, handleRunHTTPFirstRows }
}

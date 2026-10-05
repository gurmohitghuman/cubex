import React from 'react'
import toast from 'react-hot-toast'
import { aiAPI, httpAPI, AIRun, HTTPRun, Sheet } from '@/utils/api'
import { aiRunConfigFromLatest } from './aiRunConfigFromLatest'
import { plural } from '@/lib/utils'

interface Args {
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

export const useSheetGridRunActions = (a: Args) => {
  const handleRunAIForColumn = async (baseName: string) => {
    if (!a.activeSheet) return
    try {
      const runs = await aiAPI.getRuns(a.activeSheet.id)
      const latest = runs.find(r => r.column_name === `${baseName} (Output)`)
      if (!latest) {
        a.setShowAddColumnModal(true)
        toast('Configure AI column first')
        return
      }
      // aiRunConfigFromLatest forwards ALL of the prior run's fields (incl.
      // web-search/fetch flags) — omitting any would make "Run All Rows" silently
      // drop it (e.g. lose the (Data) column + citations). Shared with the
      // edit-column prefill so the two can't drift.
      const res = await aiAPI.startRun({ sheetId: a.activeSheet.id, ...aiRunConfigFromLatest(latest, baseName) })
      // No success toast — cells visibly start showing '⏳ Processing...'
      // and the header pill appears with pause/stop controls.
      a.setupSSEConnection(res.runId, 'ai')
      // Refresh active runs so the header Pause/Stop controls appear immediately
      // instead of lagging up to the SSE throttle (~5s). Mirrors the modal's
      // onRunStarted path in SheetModals.tsx.
      a.fetchActiveAIRuns(a.activeSheet.id)
      // SILENT reload (reloadSheetData is wired to the silent loader in SheetPage):
      // paints the server-written '⏳ Processing...' placeholders into the grid AND
      // runs reconnectToActiveRuns in its side-load chain, which re-attaches SSE the
      // same way a manual refresh does — but without the FullPageLoader flash a loud
      // reload caused. Without it a menu-started run's live deltas land on a grid that
      // never registered the run (the "SSE only after refresh" bug).
      a.reloadSheetData?.(a.activeSheet.id)
    } catch (e: any) {
      console.error('Run AI for column error:', e)
      toast.error(e.response?.data?.error || 'Failed to start AI run')
    }
  }

  const handleRunAIMissingOrError = async (baseName: string) => {
    if (!a.activeSheet) return
    try {
      const res = await aiAPI.rerun(a.activeSheet.id, baseName)
      toast.success(`Re-running AI for ${plural(res.targetRows, 'row')}`)
      a.setupSSEConnection(res.runId, 'ai')
      // Refresh active runs so the header Pause/Stop controls appear immediately
      // (see handleRunAIForColumn).
      a.fetchActiveAIRuns(a.activeSheet.id)
      // Silent reload so placeholders show + reconnectToActiveRuns re-attaches SSE.
      // See handleRunAIForColumn.
      a.reloadSheetData?.(a.activeSheet.id)
    } catch (e: any) {
      console.error('AI rerun error:', e)
      toast.error(e.response?.data?.error || 'Failed to re-run AI')
    }
  }

  // HTTP rerun mirrors the AI rerun handlers: start a row-subset run on an
  // existing master column, open SSE, refresh active runs so the header
  // Pause/Stop pill appears immediately (don't wait on the ~5s SSE throttle).
  const startHTTPRerun = async (
    masterColumnName: string,
    opts: { mode?: 'missing'; rowIndices?: number[] },
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
    startHTTPRerun(masterColumnName, {}, n => `Re-running HTTP for ${plural(n, 'row')}`, 'Failed to start HTTP run')

  const handleRunHTTPMissingOrError = (masterColumnName: string) =>
    startHTTPRerun(masterColumnName, { mode: 'missing' }, n => `Re-running HTTP for ${plural(n, 'row')}`, 'Failed to re-run HTTP')

  // Batched: the menu hands us all selected row indices at once (one run for the
  // whole selection), not one run per row — N runs would trip the concurrency cap.
  const handleRunHTTPForRows = (masterColumnName: string, rowIndices: number[]) => {
    if (rowIndices.length === 0) return
    return startHTTPRerun(masterColumnName, { rowIndices }, n => `Re-running HTTP for ${plural(n, 'row')}`, 'Failed to re-run HTTP')
  }

  const handleEditAIColumn = async (baseName: string) => {
    if (!a.activeSheet) return
    try {
      const runs = await aiAPI.getRuns(a.activeSheet.id)
      const latest = runs.find(r => r.column_name === `${baseName} (Output)`)
      // Stash prefill in localStorage for the modal to read — keeps the modal's
      // open/init flow unchanged.
      if (latest) {
        localStorage.setItem('ai_modal_initial', JSON.stringify({
          ...aiRunConfigFromLatest(latest, baseName),
          mode: 'edit',
        }))
      } else {
        localStorage.setItem('ai_modal_initial', JSON.stringify({ columnName: baseName, mode: 'edit' }))
      }
      a.setShowAddColumnModal(true)
    } catch {
      a.setShowAddColumnModal(true)
    }
  }

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
      const run = a.activeAIRunsList.find(r => r.column_name === columnName)
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
    handleRunAIForColumn,
    handleRunAIMissingOrError,
    handleRunHTTPForColumn,
    handleRunHTTPMissingOrError,
    handleRunHTTPForRows,
    handleEditAIColumn,
    handleStopRunForColumn,
    handleDeleteColumnWithWidthCleanup,
  }
}

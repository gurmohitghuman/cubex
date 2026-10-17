import toast from 'react-hot-toast'
import { aiAPI } from '@/utils/api'
import { aiRunConfigFromLatest } from './aiRunConfigFromLatest'
import { plural } from '@/lib/utils'
import { structuredRunOwns } from '@/lib/structuredRuns'
import type { GridRunArgs } from './useSheetGridRunActions'

// The column menu's AI Column Actions: run all rows (a structured run reruns
// from any of its columns), run missing or errors, run the first rows, and
// edit the column's instructions. Split out of useSheetGridRunActions.
export const useAIColumnRunActions = (a: GridRunArgs) => {
  // columnName is the header clicked (see handleRunAIMissingOrError).
  const handleRunAIForColumn = async (baseName: string, columnName?: string) => {
    if (!a.activeSheet) return
    try {
      const runs = await aiAPI.getRuns(a.activeSheet.id)
      // A column of a structured run (several typed columns from one call per
      // row): refill all of that run's columns on every row. That's a rerun, as
      // a fresh start would need new column names.
      if (columnName && runs.some(r => structuredRunOwns(r, columnName))) {
        const res = await aiAPI.rerun(a.activeSheet.id, baseName, { columnName, mode: 'all' })
        toast.success(`Re-running AI for ${plural(res.targetRows, 'row')}`)
        // Live updates, header controls and placeholders, as below.
        a.setupSSEConnection(res.runId, 'ai')
        a.fetchActiveAIRuns(a.activeSheet.id)
        a.reloadSheetData?.(a.activeSheet.id)
        return
      }
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

  // columnName is the header clicked, so a column of a structured run (several
  // typed columns from one call) reruns exactly the run that owns it.
  // firstRows: "Run First Rows", every one of the sheet's top rows again (a test).
  const handleRunAIMissingOrError = async (baseName: string, columnName?: string, firstRows?: number) => {
    if (!a.activeSheet) return
    try {
      const res = await aiAPI.rerun(a.activeSheet.id, baseName,
        firstRows ? { columnName, firstRows, mode: 'all' } : { columnName })
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

  const handleRunAIFirstRows = (baseName: string, columnName: string, rows: number) =>
    handleRunAIMissingOrError(baseName, columnName, rows)

  return { handleRunAIForColumn, handleRunAIMissingOrError, handleRunAIFirstRows, handleEditAIColumn }
}

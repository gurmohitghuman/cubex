import toast from 'react-hot-toast'
import { aiAPI } from '@/utils/api'
import { aiRunConfigFromLatest } from './aiRunConfigFromLatest'
import { plural } from '@/lib/utils'
import type { GridRunArgs } from './useSheetGridRunActions'

// The column menu's AI Column Actions that aren't run controls (those are
// useColumnRunControls: empty or out-of-date rows, failed rows, all rows, each with
// its estimate): run the first rows, and edit the column's instructions.
// Split out of useSheetGridRunActions.
export const useAIColumnRunActions = (a: GridRunArgs) => {
  // "Run First Rows": every one of the sheet's top rows again (a test). columnName
  // is the header clicked, so a column of a structured run (several typed
  // columns from one call) reruns exactly the run that owns it.
  const handleRunAIFirstRows = async (baseName: string, columnName: string, firstRows: number) => {
    if (!a.activeSheet) return
    try {
      const res = await aiAPI.rerun(a.activeSheet.id, baseName, { columnName, firstRows, mode: 'all' })
      toast.success(`Re-running AI for ${plural(res.targetRows, 'row')}`)
      a.setupSSEConnection(res.runId, 'ai')
      // Refresh active runs so the header Pause/Stop controls appear immediately
      // instead of lagging up to the SSE throttle (~5s).
      a.fetchActiveAIRuns(a.activeSheet.id)
      // SILENT reload (reloadSheetData is wired to the silent loader in SheetPage):
      // paints the server-written '⏳ Processing...' placeholders into the grid AND
      // runs reconnectToActiveRuns in its side-load chain, which re-attaches SSE the
      // same way a manual refresh does, without the FullPageLoader flash a loud
      // reload caused. Without it a menu-started run's live deltas land on a grid that
      // never registered the run (the "SSE only after refresh" bug).
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

  return { handleRunAIFirstRows, handleEditAIColumn }
}

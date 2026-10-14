import toast from 'react-hot-toast'
import { autorunAPI, formulaAPI, type FormulaColumnView, type FormulaStartResult, type Sheet } from '@/utils/api'
import type { FormulaMenuAction } from '@/components/aggrid/types'
import type { FormulaOpenTarget } from '@/components/formula/useFormulaForm'
import { formulaStartedText } from '@/components/formula/formula-copy'

interface Args {
  activeSheet: Sheet | null
  // The sheet's formula columns' setups (the sheet payload's formulaColumns).
  formulaColumns?: Record<string, FormulaColumnView>
  reloadSheetData?: (sheetId: string) => unknown
  // Opens the Add Column dialog on Formula, or on a formula column's setup.
  onOpenFormula?: (target: FormulaOpenTarget) => void
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// Once a formula column is saved: "Working out Work email…" while the fill
// goes on (the column shows ⏳ until its end reloads the tab), else "… is ready".
export function toastFormulaStarted(r: FormulaStartResult, id?: string): void {
  const t = formulaStartedText(r)
  if (t.tone === 'busy') toast(t.text, { id })
  else if (t.tone === 'ok') toast.success(t.text, { id })
  else toast.error(t.text, { id })
}

// The column menu's formula items. A formula is free, so nothing here asks
// first: "Work out every row again" sends the column's own formula, and the
// auto-run switch has no rule or caps (turning it on works every row out again first).
export function useFormulaColumnActions(a: Args) {
  const workOutAgain = async (sheetId: string, column: string) => {
    const rec = a.formulaColumns?.[column]
    if (!rec) { toast.error("Couldn't find this column's formula. Reload the page and try again."); return }
    const id = toast.loading(`Working out ${column}…`)
    try {
      // autoRun left out: the column's auto-run stays as it is.
      const body = { formula: rec.formula, column, ...(rec.description ? { description: rec.description } : {}) }
      toastFormulaStarted(await formulaAPI.start(sheetId, body), id)
      a.reloadSheetData?.(sheetId)
    } catch (e) {
      toast.error(errorOf(e, "Couldn't work the column out. Try again."), { id })
    }
  }

  const setAutorun = async (sheetId: string, column: string, enabled: boolean) => {
    try {
      await autorunAPI.save(sheetId, { column, enabled })
      a.reloadSheetData?.(sheetId)
    } catch (e) {
      toast.error(errorOf(e, enabled ? "Couldn't turn on auto-run." : "Couldn't turn off auto-run."))
    }
  }

  const onFormulaAction = (action: FormulaMenuAction, column: string) => {
    const sheet = a.activeSheet
    if (!sheet) return
    if (action === 'edit') a.onOpenFormula?.({ mode: 'formula-edit', column })
    else if (action === 'again') void workOutAgain(sheet.id, column)
    else void setAutorun(sheet.id, column, action === 'autorun_on')
  }

  return { onFormulaAction }
}

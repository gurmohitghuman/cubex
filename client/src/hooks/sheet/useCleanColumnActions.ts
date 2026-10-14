import toast from 'react-hot-toast'
import { autorunAPI, cleanAPI, type CleanColumnView, type CleanStartResult, type Sheet } from '@/utils/api'
import type { CleanMenuAction } from '@/components/aggrid/types'
import type { CleanOpenTarget } from '@/components/clean/useCleanForm'
import { cleanStartedText } from '@/components/clean/clean-copy'

interface Args {
  activeSheet: Sheet | null
  // The sheet's clean columns' setups (the sheet payload's cleanColumns).
  cleanColumns?: Record<string, CleanColumnView>
  reloadSheetData?: (sheetId: string) => unknown
  // Opens the Add Column dialog on Clean data (a source picked) or on a clean column's setup.
  onOpenClean?: (target: CleanOpenTarget) => void
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// Once cleaning starts: "Cleaning Name (clean)…" while the fill goes on (the
// column shows ⏳ until its end reloads the tab), else "Name (clean) is ready".
export function toastCleanStarted(r: CleanStartResult, id?: string): void {
  const t = cleanStartedText(r)
  if (t.tone === 'busy') toast(t.text, { id })
  else if (t.tone === 'ok') toast.success(t.text, { id })
  else toast.error(t.text, { id })
}

// The column menu's clean data items. Cleaning is free, so nothing here asks
// first: "Clean all rows again" sends the column's own setup, and the auto-run
// switch has no rule or caps (turning it on cleans every row again first).
export function useCleanColumnActions(a: Args) {
  const cleanAgain = async (sheetId: string, column: string) => {
    const rec = a.cleanColumns?.[column]
    if (!rec) { toast.error("Couldn't find how this column is cleaned. Reload the page and try again."); return }
    const id = toast.loading(`Cleaning ${column}…`)
    try {
      // autoRun left out: the column's auto-run stays as it is.
      const body = { source: rec.source, cleaner: rec.cleaner, column, options: rec.options }
      toastCleanStarted(await cleanAPI.start(sheetId, body), id)
      a.reloadSheetData?.(sheetId)
    } catch (e) {
      toast.error(errorOf(e, "Couldn't clean the column. Try again."), { id })
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

  const onCleanAction = (action: CleanMenuAction, column: string) => {
    const sheet = a.activeSheet
    if (!sheet) return
    if (action === 'new') a.onOpenClean?.({ mode: 'create', source: column })
    else if (action === 'edit') a.onOpenClean?.({ mode: 'edit', column })
    else if (action === 'again') void cleanAgain(sheet.id, column)
    else void setAutorun(sheet.id, column, action === 'autorun_on')
  }

  return { onCleanAction }
}

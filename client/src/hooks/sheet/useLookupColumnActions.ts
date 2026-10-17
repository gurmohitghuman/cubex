import toast from 'react-hot-toast'
import { autorunAPI, lookupAPI, type LookupColumnView, type LookupStartResult, type Sheet } from '@/utils/api'
import type { LookupMenuAction } from '@/components/aggrid/types'
import type { LookupOpenTarget } from '@/components/lookup/useLookupForm'
import { lookupStartedText } from '@/components/lookup/lookup-copy'

interface Args {
  activeSheet: Sheet | null
  // The sheet's lookup columns' setups (the sheet payload's lookupColumns).
  lookupColumns?: Record<string, LookupColumnView>
  reloadSheetData?: (sheetId: string) => unknown
  // Opens the Add Column dialog on Lookup, or on a lookup column's setup.
  onOpenLookup?: (target: LookupOpenTarget) => void
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// Once a lookup column is saved: "Looking up Industry…" while the fill goes on
// (the column shows ⏳ until its end reloads the tab), else "… is ready".
export function toastLookupStarted(r: LookupStartResult, id?: string): void {
  const t = lookupStartedText(r)
  if (t.tone === 'busy') toast(t.text, { id })
  else if (t.tone === 'ok') toast.success(t.text, { id })
  else toast.error(t.text, { id })
}

// The column menu's lookup items. A lookup is free, so nothing here asks
// first: "Look up every row again" sends the column's own setup (the other
// sheet as it is now), and the auto-run switch has no rule or caps.
export function useLookupColumnActions(a: Args) {
  const lookUpAgain = async (sheetId: string, column: string) => {
    const rec = a.lookupColumns?.[column]
    if (!rec) { toast.error("Couldn't find this column's lookup. Reload the page and try again."); return }
    if (rec.broken) { toast.error(`${rec.broken} Open "Edit lookup" to set it up again.`); return }
    const id = toast.loading(`Looking up ${column}…`)
    try {
      // autoRun left out: the column's auto-run stays as it is.
      toastLookupStarted(await lookupAPI.start(sheetId, {
        column, sourceColumn: rec.sourceColumn, otherSheetId: rec.otherSheetId, matchColumn: rec.matchColumn,
        match: rec.match, returns: rec.returns,
        ...(rec.returns === 'value' ? { returnColumn: rec.returnColumns?.[0] } : {}),
        ...(rec.returns === 'list'
          ? { limit: rec.limit, ...(rec.returnColumns ? { returnColumns: rec.returnColumns } : {}) } : {}),
      }), id)
      a.reloadSheetData?.(sheetId)
    } catch (e) {
      toast.error(errorOf(e, "Couldn't look the column up again. Try again."), { id })
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

  const onLookupAction = (action: LookupMenuAction, column: string) => {
    const sheet = a.activeSheet
    if (!sheet) return
    if (action === 'edit') a.onOpenLookup?.({ mode: 'lookup-edit', column })
    else if (action === 'again') void lookUpAgain(sheet.id, column)
    else void setAutorun(sheet.id, column, action === 'autorun_on')
  }

  return { onLookupAction }
}

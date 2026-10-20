import { useCallback, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet } from '@/utils/api'
import { plural } from '@/lib/utils'

interface UseSheetCopyArgs {
  tableId: string | null
  tableIdRef: React.MutableRefObject<string | null>
  activeSheetRef: React.MutableRefObject<Sheet | null>
  waitForSaves: (timeoutMs?: number) => Promise<boolean>
  reconcileSheets: (sheets: Sheet[]) => void
  selectSheet: (sheet: Sheet) => Promise<void>
  beginOp: () => void
  endOp: () => void
}

// The copy's column widths are the source's (both keyed by column name; useColumnWidths owns the key).
function copyColumnWidths(fromSheetId: string, toSheetId: string) {
  try {
    const saved = localStorage.getItem(`cubex-column-widths-${fromSheetId}`)
    if (saved) localStorage.setItem(`cubex-column-widths-${toSheetId}`, saved)
  } catch { /* privacy mode: the copy starts at the default widths */ }
}

// "Copy values to a new sheet" (split from useSheetOps for its line cap): the
// sheet's pending edits are saved first so the copy has them, the server adds
// the new sheet right after it and answers once every row is in, then the new
// sheet opens, unless the person moved on meanwhile (another sheet, or off the
// page): a big sheet takes a while, and a toast says it's copying.
export const useSheetCopy = ({
  tableId, tableIdRef, activeSheetRef, waitForSaves, reconcileSheets, selectSheet, beginOp, endOp,
}: UseSheetCopyArgs) => {
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const copySheet = useCallback(async (sheet: Sheet) => {
    if (!tableId) return
    const startedOn = activeSheetRef.current?.id
    if (startedOn === sheet.id) {
      const flushed = await waitForSaves(5000)
      if (!flushed) {
        toast.error("Couldn't save your pending edits; the sheet wasn't copied.")
        return
      }
    }
    const pending = toast.loading(`Copying the values of "${sheet.name}"…`)
    beginOp()
    try {
      const res = await sheetsAPI.copySheet(tableId, sheet.id)
      copyColumnWidths(sheet.id, res.sheet.id)
      toast.success(`Copied ${plural(res.rowsCopied, 'row')} to "${res.sheet.name}"`, { id: pending })
      if (!mountedRef.current || tableIdRef.current !== tableId) return // left the table
      reconcileSheets(res.sheets)
      if (activeSheetRef.current?.id === startedOn) await selectSheet(res.sheet)
    } catch (err: any) {
      toast.error(err?.response?.data?.error || "Couldn't copy the sheet", { id: pending })
    } finally { endOp() }
  }, [tableId, tableIdRef, activeSheetRef, waitForSaves, reconcileSheets, selectSheet, beginOp, endOp])

  return { copySheet }
}

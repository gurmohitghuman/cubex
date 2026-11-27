import { useCallback, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet } from '@/utils/api'

export const useExport = (
  activeSheet: Sheet | null,
  // Drains the autosave queue before exporting. The export reads rows.data from
  // the DB server-side, so un-flushed edits (still in unsavedChanges within the
  // debounce/retry window) would be MISSING from the CSV. Same barrier the
  // sort/delete/rename paths use.
  waitForSaves: (timeoutMs?: number) => Promise<boolean>,
) => {
  const [isExporting, setIsExporting] = useState(false)
  // One export at a time, until its file is handed to the browser: a click meanwhile (a double click) does
  // nothing. A ref, so a second click before the button repaints is caught too.
  const busy = useRef(false)

  // scope 'view': the rows and visible columns of the view showing (viewName names the file). forTools: every
  // cell exactly as it is, for importing into a CRM or email tool (the file says "for import").
  const handleExportCSV = useCallback(async (scope: 'view' | 'sheet' = 'sheet', viewName = '', forTools = false) => {
    if (!activeSheet || busy.current) return
    busy.current = true
    setIsExporting(true)

    try {
      // Flush pending edits FIRST so the CSV reflects what the user sees, not the
      // last-saved DB state. On timeout, abort rather than export stale data.
      const flushed = await waitForSaves(5000)
      if (!flushed) {
        toast.error("Couldn't save your pending edits; export cancelled. Check your connection and try again.")
        return
      }
      // Yield a frame before the blob call so the button can repaint as disabled.
      await new Promise(resolve => requestAnimationFrame(resolve))
      const blob = await sheetsAPI.exportCSV(activeSheet.id, scope === 'view' ? 'active' : undefined, forTools)
      requestAnimationFrame(() => {
        const url = window.URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        const base = scope === 'view' && viewName ? `${activeSheet.name} - ${viewName}` : activeSheet.name
        link.download = forTools ? `${base} (for import).csv` : `${base}.csv`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        window.URL.revokeObjectURL(url)
      })
      // No success toast — the browser already shows its own download
      // notification when the file lands.
    } catch (error) {
      // The body of a failed blob request is a Blob: read its { error } (a view that can't be read says why).
      const body = (error as { response?: { data?: Blob } })?.response?.data
      let message = ''
      try { message = body instanceof Blob ? JSON.parse(await body.text()).error ?? '' : '' } catch { /* none */ }
      toast.error(message || 'Failed to export CSV')
    } finally {
      busy.current = false
      setIsExporting(false)
    }
  }, [activeSheet, waitForSaves])

  return { isExporting, handleExportCSV }
}

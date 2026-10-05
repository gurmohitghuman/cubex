import { useCallback, useState } from 'react'
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

  // Debounced — prevents multiple rapid clicks from queueing CSV downloads.
  const handleExportCSV = useCallback(async () => {
    if (!activeSheet || isExporting) return
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
      const blob = await sheetsAPI.exportCSV(activeSheet.id)
      requestAnimationFrame(() => {
        const url = window.URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `${activeSheet.name}.csv`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        window.URL.revokeObjectURL(url)
      })
      // No success toast — the browser already shows its own download
      // notification when the file lands.
    } catch {
      toast.error('Failed to export CSV')
    } finally {
      setTimeout(() => setIsExporting(false), 1000)
    }
  }, [activeSheet, isExporting, waitForSaves])

  return { isExporting, handleExportCSV }
}

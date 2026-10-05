import { useCallback, useMemo } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet, SheetData } from '@/utils/api'
import type { SourcesCell } from '@/components/ScrapedDataModal'

interface UseSheetViewArgs {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  emptyFilter: Record<string, 'empty' | 'not_empty'>
  setScrapedDataModal: (s: { isOpen: boolean; cell: SourcesCell | null }) => void
  // Sort is a one-time PHYSICAL reorder (Google Sheets semantics): the server
  // rewrites row_index, then we reload. There is no client-side live sort —
  // rows render in row_index order and never move when cell values change.
  reloadSheet: () => Promise<void> | void
  // Resolves true once all pending autosaves have flushed (false on timeout).
  // The sort rewrites row_index, so an in-flight cell PUT keyed on the old
  // index would land in the wrong row — flush before sorting.
  waitForSaves: (timeoutMs?: number) => Promise<boolean>
  // Empties the row selection. Called at the START of a sort, before the server
  // rewrites row_index, so the header "Delete (N)" button can't fire against
  // pre-reorder indices during the in-flight sort POST.
  clearSelection: () => void
  // Flips the page into the FullPageLoader for the WHOLE sort, including the
  // POST. This unmounts the grid (and any open header context menu holding a
  // pre-reorder selection), closing the grid-menu "Delete selected rows" vector
  // that clearSelection alone can't reach (the menu captures the grid's own
  // local selection, not the parent state clearSelection zeroes).
  setIsLoading: (loading: boolean) => void
}

export const useSheetView = ({
  activeSheet, sheetData, emptyFilter,
  setScrapedDataModal, reloadSheet, waitForSaves, clearSelection, setIsLoading,
}: UseSheetViewArgs) => {
  const filteredRows = useMemo(() => {
    if (!sheetData?.data?.rows) return []
    const rows = sheetData.data.rows
    const entries = Object.entries(emptyFilter)
    if (entries.length === 0) return rows
    return rows.filter(r => {
      for (const [col, mode] of entries) {
        const v = (r.data as any)[col]
        const s = v === undefined || v === null ? '' : String(v)
        const isEmpty = s.trim() === ''
        if (mode === 'empty' && !isEmpty) return false
        if (mode === 'not_empty' && isEmpty) return false
      }
      return true
    })
  }, [sheetData, emptyFilter])

  const handleSortChange = useCallback(async (columnId: string, direction?: 'asc' | 'desc' | null) => {
    if (!activeSheet || !direction) return
    // Clear selection AND swap in the FullPageLoader UP FRONT, before the server
    // rewrites row_index. Selection is keyed by row_index; if it survived into
    // the in-flight sort POST, the header "Delete (N)" button OR the grid's
    // right-click "Delete selected rows" would bulk-delete by now-stale indices
    // pointing at different logical rows. setIsLoading(true) unmounts the grid
    // (and its menu) for the whole operation, closing both vectors; clearSelection
    // zeroes the parent state behind it. The post-sort loud reload clears isLoading.
    clearSelection()
    setIsLoading(true)
    const flushed = await waitForSaves(5000)
    if (!flushed) {
      setIsLoading(false)
      toast.error("Couldn't save your pending edits; sort cancelled. Check your connection and try again.")
      return
    }
    try {
      await sheetsAPI.sortSheet(activeSheet.id, columnId, direction)
      await reloadSheet()
    } catch (error: any) {
      // reloadSheet didn't run (or failed) — clear the loader ourselves.
      setIsLoading(false)
      toast.error(error.response?.data?.error || 'Failed to sort sheet')
    }
  }, [activeSheet, reloadSheet, waitForSaves, clearSelection, setIsLoading])

  const handleCellClick = useCallback((rowIndex: number, columnName: string, value?: unknown) => {
    // A "(Data)" cell holding an AI run's sources summary (📊 …) opens the
    // sources modal, which asks the server for that one cell's sources. Other
    // long-content cells use AG Grid's large-text popup editor (buildColumnDefs).
    if (!activeSheet || !columnName.endsWith(' (Data)')) return
    if (typeof value !== 'string' || !value.startsWith('📊')) return
    setScrapedDataModal({ isOpen: true, cell: { sheetId: activeSheet.id, rowIndex, columnName } })
  }, [activeSheet, setScrapedDataModal])

  // Kept under its historical name to limit churn at the call sites: these are
  // the rows the grid renders — row_index order, empty-filter applied. No sort.
  const sortedRows = filteredRows

  return { filteredRows, sortedRows, handleSortChange, handleCellClick }
}

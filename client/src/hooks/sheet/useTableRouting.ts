import { useEffect, type MutableRefObject } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Sheet, SheetData, Table, tablesAPI } from '@/utils/api'

interface Args {
  tableId: string | undefined
  urlSheetId: string | undefined
  navigate: NavigateFunction
  table: Table | null
  setTable: (t: Table | null) => void
  activeSheet: Sheet | null
  setActiveSheet: (s: Sheet | null) => void
  setSheetData: (d: SheetData | null) => void
  setIsLoading: (v: boolean) => void
  setLoadedRowsCount: (n: number) => void
  currentSheetIdRef: MutableRefObject<string | null>
  selectSheet: (s: Sheet) => Promise<void> | void
  clearSelection: () => void
  loadSheetData: (sheetId: string) => Promise<void> | void
}

// Which table and sheet the page shows: the table load per tableId, the first
// sheet (or the URL's) once it loads, the URL's sheet on back/forward, and the
// active sheet's data load whenever it changes.
export function useTableRouting(a: Args): void {
  const {
    tableId, urlSheetId, navigate, table, setTable, activeSheet, setActiveSheet, setSheetData, setIsLoading,
    setLoadedRowsCount, currentSheetIdRef, selectSheet, clearSelection, loadSheetData,
  } = a
  // Table load — runs once per tableId. NOTE: this effect re-fires when the user
  // navigates BETWEEN tables (e.g. "create a new table for the webhook" routes to
  // a different /table/:id). The auto-pick-sheet effect below only picks a sheet
  // when `!activeSheet`, so we MUST clear activeSheet (+ its derived state) here —
  // otherwise the old table's sheet stays selected, the new table's sheet is never
  // picked, the sheet-data load never fires, and the page hangs on the loader.
  useEffect(() => {
    if (!tableId) return
    setIsLoading(true)
    setActiveSheet(null)
    setSheetData(null)
    setTable(null)
    tablesAPI.getById(tableId)
      .then(setTable)
      .catch(() => { toast.error('Failed to load table'); navigate('/dashboard') })
  }, [tableId, navigate])

  // Auto-pick a sheet of a freshly-loaded table: the URL's sheet if present + valid,
  // else the first sheet. Only when nothing is active yet (no loop; back/forward on an
  // already-active table is handled by the [urlSheetId] sync effect below).
  useEffect(() => {
    if (!table?.sheets) return
    if (table.sheets.length > 0 && !activeSheet) {
      const fromUrl = urlSheetId ? table.sheets.find(s => s.id === urlSheetId) : undefined
      setActiveSheet(fromUrl ?? table.sheets[0])
    }
    // A table with no sheets never picks an activeSheet, so the activeSheet
    // effect's loadSheetData (the only thing that clears the table-load
    // setIsLoading(true)) never runs — without this the FullPageLoader would
    // hang forever. Not reachable via today's UI (every table is created with a
    // sheet, no per-sheet delete exists), but a safety net for any future
    // sheet-delete / partial-migration path. SheetTabsBar + SheetEmptyState
    // render a sane empty state with activeSheet null.
    else if (table.sheets.length === 0) setIsLoading(false)
  }, [table]) // intentionally not depending on activeSheet — would loop

  // Same-table URL change (browser back/forward, or an external deep-link swap between
  // two sheets of the SAME table). The auto-pick effect above only fires on !activeSheet,
  // so this keeps activeSheet in sync when the URL sheetId changes while a sheet is
  // already active. Always route through selectSheet (never a raw setActiveSheet) so the
  // waitForSaves barrier runs; selectSheet skips its own navigate when the URL already
  // matches, so this can't loop.
  useEffect(() => {
    if (!urlSheetId || !table?.sheets || !activeSheet) return
    if (urlSheetId === activeSheet.id) return
    const target = table.sheets.find(s => s.id === urlSheetId)
    if (target) void selectSheet(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSheetId])

  // When activeSheet changes, kick off its data load.
  useEffect(() => {
    if (!activeSheet) return
    currentSheetIdRef.current = activeSheet.id
    setLoadedRowsCount(0)
    // Clear row selection — it's stored by row_index, which means different
    // logical rows on a different sheet. A loud reload remounts the grid with
    // no selection but fires no selectionChanged, so the stale parent state
    // would otherwise drive the header "Delete (N)" button against the wrong
    // sheet's rows. Same reasoning applies after sort/import (handled there).
    clearSelection()
    setIsLoading(true)
    loadSheetData(activeSheet.id)
  }, [activeSheet]) // intentionally not depending on loadSheetData — would re-fire on every render
}

import { useCallback, useRef } from 'react'
import { sheetsAPI, Sheet, SheetData } from '@/utils/api'
import { SILENT_RELOAD_PAGE_ROWS } from '@/lib/constants'

// Scroll-end pagination, extracted from useSheetLoad (file-size split; the
// ordering refs stay owned by useSheetLoad and are passed in so both hooks
// keep ONE shared view of load supersession — see useSheetLoad for the token
// semantics).
export function useSheetLoadMore(args: {
  activeSheet: Sheet | null
  loadedRowsCount: number
  windowStart: number
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  setLoadedRowsCount: React.Dispatch<React.SetStateAction<number>>
  currentSheetIdRef: React.MutableRefObject<string | null>
  // useSheetLoad's monotonic tokens (loud-load generation / commit ordering).
  loadGenRef: React.MutableRefObject<number>
  silentSeqRef: React.MutableRefObject<number>
}) {
  const {
    activeSheet, loadedRowsCount, windowStart, setSheetData, setLoadedRowsCount, currentSheetIdRef, loadGenRef,
    silentSeqRef,
  } = args
  const loadingMoreRef = useRef(false)

  const loadMoreData = useCallback(async (_requestedOffset: number, limit = 200) => {
    if (!activeSheet || loadingMoreRef.current) return
    loadingMoreRef.current = true
    // Capture identity at fetch start; a loud load (sheet switch / sort reload)
    // that bumps the token or changes the current sheet while this page is in
    // flight invalidates it — merging it then would inject stale/foreign rows.
    const sheetId = activeSheet.id
    const myGen = loadGenRef.current
    // Commit-ordering guard vs SILENT loads (which don't bump loadGenRef): a
    // full-window reload that started after this page fetch supersedes it. The
    // page was requested at an ordinal offset the reload's trigger may have
    // shifted (bulk delete → window-refill reload) — merging it would inject
    // rows from stale positions and misalign loadedRowsCount. Discard instead;
    // the next scroll-end re-fetches from the correct offset.
    const myCommitSeq = silentSeqRef.current
    // The window this page continues: a search jump that starts while the page
    // is on its way (and so passes the commit token) holds other rows.
    const myStart = windowStart
    let added = 0

    try {
      const newData = await sheetsAPI.getData(sheetId, limit, loadedRowsCount)
      if (newData.data.rows.length === 0) return
      if (myGen !== loadGenRef.current || currentSheetIdRef.current !== sheetId) return
      if (myCommitSeq !== silentSeqRef.current) return

      setSheetData(prev => {
        if (!prev) { added = newData.data.rows.length; return newData }
        if ((prev.data.windowStart ?? 0) !== myStart) return prev
        added = newData.data.rows.length
        const existingRowsMap = new Map<number, number>()
        prev.data.rows.forEach((row, index) => existingRowsMap.set(row.rowIndex, index))

        const combinedRows = [...prev.data.rows]
        newData.data.rows.forEach(newRow => {
          const existingIndex = existingRowsMap.get(newRow.rowIndex)
          if (existingIndex === undefined) combinedRows.push(newRow)
          // Overlapping row: LOCAL values win. The local copy is the user's
          // live edit state — a page fetched while an autosave PUT was still
          // in flight carries the PRE-edit value, and server-wins repainted
          // just-deleted/just-edited cells with their old contents. Keys the
          // local row doesn't have yet still come in from the server.
          else combinedRows[existingIndex] = {
            ...combinedRows[existingIndex],
            data: { ...newRow.data, ...combinedRows[existingIndex].data },
          }
        })

        const needsSorting = newData.data.rows.some(newRow => !existingRowsMap.has(newRow.rowIndex))
        return {
          ...prev,
          data: {
            ...prev.data,
            rows: needsSorting ? combinedRows.sort((a, b) => a.rowIndex - b.rowIndex) : combinedRows,
            columns: [...new Set([...prev.data.columns, ...newData.data.columns])],
            totalRows: newData.data.totalRows,
            // Take the page's fresh column-type map (same sheet, newer snapshot).
            columnTypes: newData.data.columnTypes ?? prev.data.columnTypes,
          },
        }
      })

      // Read in the next updater: React runs both in order (as in useRowOps' delete).
      setLoadedRowsCount(prev => prev + added)
    } catch (error: any) {
      console.error('Load more data error:', error)
    } finally {
      // Always clear the lock — earlier code only cleared on success/empty paths.
      loadingMoreRef.current = false
    }
  }, [activeSheet, loadedRowsCount, windowStart, setSheetData, setLoadedRowsCount, currentSheetIdRef, loadGenRef,
    silentSeqRef])

  // A window that starts deep in the sheet (search jumped there): the rows
  // just above it, when the user scrolls up to its top. Same supersession
  // guards as loadMoreData. The page reaches one row into the window: it fits
  // only when that row is the window's first (no row added or removed above
  // it since) and the rows weren't reordered, else it's dropped.
  // limit: rows above the window; with the overlap row it stays within one server page (1,000).
  const loadEarlierData = useCallback(async (
    start0: number, firstRowIndex: number, limit = SILENT_RELOAD_PAGE_ROWS - 1,
  ) => {
    if (!activeSheet || loadingMoreRef.current || start0 <= 0) return
    loadingMoreRef.current = true
    const sheetId = activeSheet.id, myGen = loadGenRef.current, myCommitSeq = silentSeqRef.current
    const start = Math.max(0, start0 - limit)
    try {
      const page = await sheetsAPI.getData(sheetId, start0 - start + 1, start)
      if (myGen !== loadGenRef.current || currentSheetIdRef.current !== sheetId) return
      if (myCommitSeq !== silentSeqRef.current) return
      const rows = page.data.rows
      if (rows.length !== start0 - start + 1 || rows[rows.length - 1].rowIndex !== firstRowIndex) return
      setSheetData(prev => {
        if (!prev || prev.sheet.id !== sheetId || (prev.data.windowStart ?? 0) !== start0) return prev
        if (prev.data.rows[0]?.rowIndex !== firstRowIndex) return prev
        if (prev.sheet.row_generation !== page.sheet.row_generation) return prev
        return { ...prev, data: { ...prev.data, rows: [...rows.slice(0, -1), ...prev.data.rows], windowStart: start } }
      })
    } catch (error: any) {
      console.error('Load earlier rows error:', error)
    } finally {
      loadingMoreRef.current = false
    }
  }, [activeSheet, setSheetData, currentSheetIdRef, loadGenRef, silentSeqRef])

  return { loadMoreData, loadEarlierData }
}

import { useCallback, useRef } from 'react'
import { sheetsAPI, Sheet, SheetData } from '@/utils/api'

// Scroll-end pagination, extracted from useSheetLoad (file-size split; the
// ordering refs stay owned by useSheetLoad and are passed in so both hooks
// keep ONE shared view of load supersession — see useSheetLoad for the token
// semantics).
export function useSheetLoadMore(args: {
  activeSheet: Sheet | null
  loadedRowsCount: number
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  setLoadedRowsCount: React.Dispatch<React.SetStateAction<number>>
  currentSheetIdRef: React.MutableRefObject<string | null>
  // useSheetLoad's monotonic tokens (loud-load generation / commit ordering).
  loadGenRef: React.MutableRefObject<number>
  silentSeqRef: React.MutableRefObject<number>
}) {
  const { activeSheet, loadedRowsCount, setSheetData, setLoadedRowsCount, currentSheetIdRef, loadGenRef, silentSeqRef } = args
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

    try {
      const newData = await sheetsAPI.getData(sheetId, limit, loadedRowsCount)
      if (newData.data.rows.length === 0) return
      if (myGen !== loadGenRef.current || currentSheetIdRef.current !== sheetId) return
      if (myCommitSeq !== silentSeqRef.current) return

      setSheetData(prev => {
        if (!prev) return newData
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

      setLoadedRowsCount(prev => prev + newData.data.rows.length)
    } catch (error: any) {
      console.error('Load more data error:', error)
    } finally {
      // Always clear the lock — earlier code only cleared on success/empty paths.
      loadingMoreRef.current = false
    }
  }, [activeSheet, loadedRowsCount, setSheetData, setLoadedRowsCount, currentSheetIdRef, loadGenRef, silentSeqRef])

  return { loadMoreData }
}

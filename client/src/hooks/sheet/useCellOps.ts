import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Sheet, SheetData } from '@/utils/api'
import { useAutosave } from '@/hooks/useAutosave'
import { stripControlChars, clampCellCharsClient } from '@/lib/utils'
import { CELL_MAX_BASIC } from '@/lib/constants'
import { CellChange, SavedCell, cellMatches } from './cellQueue'
import { flushCellEdits } from './flushCellEdits'
import { useQueueReconcile } from './useQueueReconcile'
import { useRowOps } from './useRowOps'
import { usePendingEditsStash } from './usePendingEditsStash'

interface UseCellOpsArgs {
  activeSheet: Sheet | null
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  // Keeps the loaded-rows window (the loadMore server offset) aligned after an
  // optimistic bulk delete, so the next "load more" doesn't skip rows.
  setLoadedRowsCount: React.Dispatch<React.SetStateAction<number>>
  // View state — used only to EXPLAIN view-driven row hiding after an edit
  // (the toast in handleOptimizedCellEdit), never to change the edit itself.
  emptyFilter: Record<string, 'empty' | 'not_empty'>
  // Per-sheet row_generation the client last loaded (sheetId → generation).
  // Sent with cell-edit / bulk-delete writes so the server can 409 a stale-index
  // write after a sort/replace happened elsewhere (server migration 021).
  rowGenerationRef: React.MutableRefObject<Map<string, number>>
  // Loud reload of the active sheet — recovers correct row indices after a 409.
  reloadActiveSheet: (opts?: { silent?: boolean }) => void
}

export const useCellOps = ({
  activeSheet, setSheetData, setLoadedRowsCount, emptyFilter,
  rowGenerationRef, reloadActiveSheet,
}: UseCellOpsArgs) => {
  const [unsavedChanges, setUnsavedChanges] = useState<CellChange[]>([])
  const [selectedRowIndices, setSelectedRowIndices] = useState<number[]>([])

  // Render-synced ref to the live queue, consumed by waitForSaves and by the
  // silent-reload overlay (useSheetLoad) so neither reads a stale closure.
  const pendingEditsRef = useRef<CellChange[]>(unsavedChanges)
  pendingEditsRef.current = unsavedChanges

  // Edits whose PUT has been ACKED but which a loud reload hasn't yet
  // re-fetched. onSaved removes them from unsavedChanges (so pendingEditsRef no
  // longer has them), but the optimistic value still lives only in sheetData —
  // a flat silent-reload replace would clobber it with a pre-PUT server read.
  // The silent overlay consults this too; entries self-clean once a server GET
  // is observed already carrying the saved value (or on a loud reload). Keyed
  // `${sheetId}\x00${rowIndex}\x00${columnName}` → saved value.
  const recentlySavedRef = useRef<Map<string, SavedCell>>(new Map())

  // Forward reference to useAutosave's isPaused (declared below). Lets
  // waitForSaves (useQueueReconcile) distinguish "saves are stuck" from "flushing is intentionally
  // frozen by a rename's pause" without a circular hook dependency.
  const isPausedRef = useRef<() => boolean>(() => false)

  const { waitForSaves, dropPendingForRows, dropPendingForColumn, dropAllPending, renamePendingColumn } =
    useQueueReconcile({ activeSheet, setUnsavedChanges, pendingEditsRef, recentlySavedRef, isPausedRef })

  // Memoized so AGGridSpreadsheet's onCellEdit prop is stable — re-creating it every
  // render kicks off needless grid re-renders.
  const handleOptimizedCellEdit = useCallback((rowIndex: number, column: string, rawValue: string) => {
    if (!activeSheet) return
    const sheetId = activeSheet.id
    // Strip control chars HERE so the optimistic value matches what the server
    // persists (it strips on write). Without this, a CRLF paste shows '\r' in the
    // grid but saves '\n'-only — an invisible divergence until reload (L10).
    let value = stripControlChars(rawValue)
    // Pre-guard the basic-cell size cap (P2-8): truncate + warn at edit time.
    // A server 400 would reject the WHOLE autosave batch and strand every other
    // queued edit (the frozen-queue class); the server also drops oversize cells
    // as a backstop, but clipping here keeps the optimistic value == what saves.
    if (value.length > CELL_MAX_BASIC) {
      value = clampCellCharsClient(value, CELL_MAX_BASIC) // surrogate-safe, no lone-surrogate at the cut
      toast.error(`Cell truncated to ${CELL_MAX_BASIC.toLocaleString()} characters (the limit for a typed cell).`)
    }
    // Synchronous on purpose. Previously wrapped in requestAnimationFrame for
    // grid perf, but that left AG Grid's internal model and React's sheetData
    // out of sync for ~1 frame — any re-render in that window (SSE, scroll
    // loadMore, autosave round-trip) recomputed rowData from the stale value
    // and repainted the cell to its pre-edit value. Worst symptom: press
    // Delete on a cell, server stores empty, UI flashes the old value back.
    // De-dup is keyed by (sheetId, rowIndex, columnName) so an edit to the same
    // cell on a DIFFERENT sheet (same indices, different sheet) is not merged.
    setUnsavedChanges(prev => {
      const filtered = prev.filter(c =>
        !(c.sheetId === sheetId && c.rowIndex === rowIndex && c.columnName === column))
      // generation stamped at EDIT time (see CellChange) — flush sends it as the
      // fence value, so a generation change between now and the flush 409s this
      // edit instead of letting a reseeded ref bless its stale row index.
      return [...filtered, { sheetId, rowIndex, columnName: column, value, generation: rowGenerationRef.current.get(sheetId) }]
    })

    // Maintain stable row ordering by row_index — AG Grid uses row_index as its row id,
    // and swapping positions would cause a row to remount.
    setSheetData(prev => {
      if (!prev) return prev
      const updatedRows = [...prev.data.rows]
      const existingIdx = updatedRows.findIndex(r => r.rowIndex === rowIndex)
      if (existingIdx !== -1) {
        updatedRows[existingIdx] = {
          ...updatedRows[existingIdx],
          data: { ...updatedRows[existingIdx].data, [column]: value },
        }
      } else {
        const newRow = { rowIndex, data: { [column]: value } }
        let insertIdx = updatedRows.length
        for (let i = 0; i < updatedRows.length; i++) {
          if (updatedRows[i].rowIndex > rowIndex) { insertIdx = i; break }
        }
        updatedRows.splice(insertIdx, 0, newRow)
      }
      return { ...prev, data: { ...prev.data, rows: updatedRows } }
    })

    // An edit can hide the row when an active empty-filter no longer matches
    // it — correct view behavior, but from a Delete keypress it reads as "my
    // whole row got deleted". Say what happened. (Sorting can't move rows on
    // edit anymore — sort is a one-time physical reorder now.) Toast id
    // dedupes rapid repeats (e.g. clearing several cells in a row).
    const isEmpty = value.trim() === ''
    const filterMode = emptyFilter[column]
    if ((filterMode === 'not_empty' && isEmpty) || (filterMode === 'empty' && !isEmpty)) {
      toast(
        `Row hidden: it no longer matches the "${filterMode === 'empty' ? 'show empty only' : 'show non-empty only'}" filter on "${column}". Clear the filter to see it.`,
        { icon: '👁️', id: 'row-hidden-by-filter' },
      )
    }
  }, [activeSheet, setSheetData, emptyFilter])

  const { handleDeleteRows, handleAddRows } = useRowOps({
    activeSheet, setSheetData, setLoadedRowsCount, rowGenerationRef, reloadActiveSheet,
    waitForSaves, dropPendingForRows,
  })

  // Autosave: debounced save of unsavedChanges to server, Google Sheets style.
  // No manual save button — every cell edit gets persisted within ~100ms of the last keystroke.
  const { status: saveStatus, retry: retrySave, setPaused: setAutosavePaused, isPaused, hasPending } = useAutosave({
    pending: unsavedChanges,
    save: (items) => flushCellEdits(items, { recentlySavedRef, setUnsavedChanges, reloadActiveSheet }),
    onSaved: (savedItems) => {
      // Prune the saved items from the queue. (recentlySavedRef is populated in
      // flushCellEdits, per-group on ack, so a 409'd group is never recorded.) More
      // edits may have arrived during the request — match exactly.
      // cellMatches includes generation — an acked old-generation edit must not
      // prune a newer same-value edit queued at the same coordinates.
      setUnsavedChanges(prev => prev.filter(p =>
        !savedItems.some(s => cellMatches(s, p),
        ),
      ))
    },
    debounceMs: 100,
  })
  // Wire isPaused into the forward ref so waitForSaves (declared above) can see
  // it. isPaused reads a live ref inside useAutosave, so capturing it here is safe.
  isPausedRef.current = isPaused

  // Warn the user before navigating away if we still have un-flushed edits.
  useEffect(() => {
    if (!hasPending) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasPending])

  // Mirror the queue to localStorage + restore it on sheet activation, so a
  // session-expiry teardown doesn't lose un-flushed edits.
  usePendingEditsStash({ activeSheet, unsavedChanges, setUnsavedChanges, rowGenerationRef })

  return {
    unsavedChanges,
    pendingEditsRef,
    recentlySavedRef,
    selectedRowIndices,
    setSelectedRowIndices,
    saveStatus,
    retrySave,
    waitForSaves,
    setAutosavePaused,
    dropPendingForColumn,
    dropAllPending,
    renamePendingColumn,
    handleOptimizedCellEdit,
    handleDeleteRows,
    handleAddRows,
  }
}

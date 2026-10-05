import { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet, SheetData } from '@/utils/api'

interface UseColumnRenameArgs {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  columnOrder: string[]
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  setColumnOrder: React.Dispatch<React.SetStateAction<string[]>>
  setEmptyFilter: React.Dispatch<React.SetStateAction<Record<string, 'empty' | 'not_empty'>>>
  // Text ("contains") filters are keyed by column name too; without migrating
  // this on rename, the renamed column's filter box goes blank AND every later
  // filter PUT carries the stale old-name key → the server 400s ("unknown
  // column") and wedges all filter edits until a reload. Value type mirrors
  // SheetPage's columnFilters state.
  setColumnFilters: React.Dispatch<React.SetStateAction<Record<string, { type: 'contains'; value: string }>>>
  setLastRenamedColumn: (v: { from: string; to: string; at: number }) => void
  waitForSaves: (timeoutMs?: number) => Promise<boolean>
  renamePendingColumn: (oldName: string, newName: string) => void
  setAutosavePaused: (paused: boolean) => void
}

// Optimistic column rename (Google-Sheets feel) — extracted from useColumnOps to
// keep both files under the 200-line cap. The new header shows IMMEDIATELY and the
// save runs in the background; data-safety invariants are preserved (see handler).
export const useColumnRename = ({
  activeSheet, sheetData, columnOrder, setSheetData, setColumnOrder, setEmptyFilter,
  setColumnFilters, setLastRenamedColumn, waitForSaves, renamePendingColumn, setAutosavePaused,
}: UseColumnRenameArgs) => {
  // Live ref to the active sheet so a BACKGROUND rename result (success re-assert or
  // failure rollback) no-ops when the user has navigated to a different sheet
  // mid-flight — it must never mutate another sheet's view.
  const activeSheetRef = useRef<Sheet | null>(activeSheet)
  activeSheetRef.current = activeSheet

  // Apply a column rename to ALL local view state in one batch: the colId signal
  // (must lead so AG Grid moves the colId rather than remove+add), rows.data keys,
  // column order, and empty_filter. Pure client-side + sheet-pinned. Used for both
  // the optimistic forward apply AND the failure rollback (just swap from/to).
  const applyLocalRename = useCallback((sheetId: string, from: string, to: string) => {
    if (activeSheetRef.current?.id !== sheetId) return // navigated away mid-flight
    setLastRenamedColumn({ from, to, at: Date.now() })
    setSheetData(prev => {
      if (!prev) return prev
      return {
        ...prev,
        data: {
          ...prev.data,
          columns: prev.data.columns.map(c => (c === from ? to : c)),
          rows: prev.data.rows.map(r => {
            if (!(from in r.data)) return r
            const { [from]: val, ...rest } = r.data
            return { ...r, data: { ...rest, [to]: val } }
          }),
        },
      }
    })
    setColumnOrder(prev => prev.map(c => (c === from ? to : c)))
    setEmptyFilter(prev => {
      if (!(from in prev)) return prev
      const { [from]: mode, ...rest } = prev
      return { ...rest, [to]: mode }
    })
    // Migrate the text filter key too (server does this; client must match or
    // the filter goes blank + later filter PUTs 400 on the stale key).
    setColumnFilters(prev => {
      if (!(from in prev)) return prev
      const { [from]: f, ...rest } = prev
      return { ...rest, [to]: f }
    })
  }, [setSheetData, setColumnOrder, setEmptyFilter, setColumnFilters, setLastRenamedColumn])

  // The new header shows IMMEDIATELY; the save runs in the background — no waiting on
  // the server round-trip (the lag the old pessimistic version had, amplified by prod
  // latency). Data-safety invariants all preserved: (1) waitForSaves barrier flushes
  // old-name edits FIRST (instant when the queue is empty — the common case), so the
  // server migrates them under oldName; (2) autosave stays paused for the in-flight
  // request so a fresh edit can't flush mid-rename and resurrect a ghost column — it
  // only queues, and we remap it; (3) on FAILURE we roll back the UI + queued edits to
  // oldName, losing nothing. Mirrors the optimistic handleColumnReorder pattern.
  const handleRenameColumn = useCallback(async (oldName: string, rawName: string): Promise<boolean> => {
    const sheetId = activeSheet?.id
    if (!sheetId) return false
    // Server-canonical form (collapse internal whitespace) so the grid key matches
    // the stored key (M6).
    const newName = rawName.trim().replace(/\s+/g, ' ')
    if (!newName || newName === oldName) return true
    // Local case/exact pre-check so a guaranteed-conflict never optimistically flips
    // (and has to roll back). The server is still authoritative.
    const cols = columnOrder.length > 0 ? columnOrder : (sheetData?.data.columns ?? [])
    if (cols.some(c => c !== oldName && c.toLowerCase() === newName.toLowerCase())) {
      toast.error(`A column named "${newName}" already exists`)
      return false
    }

    // Barrier: drain any edits queued under oldName so the server migrates them in
    // the rename txn. Empty-queue fast path → resolves instantly (common case), so
    // the optimistic flip below is immediate.
    const flushed = await waitForSaves(5000)
    if (!flushed) {
      toast.error("Couldn't save your pending edits; rename cancelled. Check your connection and try again.")
      return false
    }

    // Freeze flushing for the round-trip, then flip the UI optimistically. A cell edit
    // the user makes now queues under newName (AG Grid's field is already newName) but
    // can't flush until we know the server outcome.
    setAutosavePaused(true)
    renamePendingColumn(oldName, newName)
    applyLocalRename(sheetId, oldName, newName)

    void sheetsAPI.renameColumn(sheetId, oldName, newName)
      .then(() => {
        // Re-assert in case a silent reload mid-flight repainted the server's
        // still-old metadata; no-op if already applied.
        renamePendingColumn(oldName, newName)
        applyLocalRename(sheetId, oldName, newName)
      })
      .catch((err: any) => {
        // Roll back BEFORE unpausing: remap edits made during the pause newName→
        // oldName (the column is still oldName server-side) and revert the view, so
        // no edit is lost and no newName ghost appears.
        renamePendingColumn(newName, oldName)
        applyLocalRename(sheetId, newName, oldName)
        toast.error(err.response?.data?.error || 'Failed to rename column')
      })
      .finally(() => setAutosavePaused(false))

    return true
  }, [activeSheet, sheetData, columnOrder, waitForSaves, renamePendingColumn, setAutosavePaused, applyLocalRename])

  return { handleRenameColumn }
}

import { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet, Table } from '@/utils/api'
import { useSheetRename } from './useSheetRename'
import { useSheetReconcile } from './useSheetReconcile'

interface UseSheetOpsArgs {
  table: Table | null
  setTable: React.Dispatch<React.SetStateAction<Table | null>>
  activeSheet: Sheet | null
  setActiveSheet: (s: Sheet | null) => void
  // URL sync: navigate to /table/:tableId/:sheetId (replace). Reads the CURRENT url
  // sheetId so callers can decide whether a navigate is needed.
  currentUrlSheetId: string | null
  navigateToSheet: (sheetId: string) => void
  waitForSaves: (timeoutMs?: number) => Promise<boolean>
  dropAllPending: (sheetId: string) => void
  // Set synchronously with setActiveSheet on a switch so the grid-area loader is up
  // before the grid could paint the outgoing sheet's rows (closes a one-frame stale
  // render). The activeSheet-change effect also loads + clears it in finally.
  setIsLoading: (loading: boolean) => void
  // Clear the outgoing sheet's data on a switch. Belt-and-braces with setIsLoading: if
  // the new sheet's load FAILS (isLoading clears in finally), there's then no stale
  // old-sheet sheetData left to render under the new tab.
  clearSheetData: () => void
  // The load-discard ref (useSheetLoad guards commits on currentSheetIdRef.current ===
  // sheetId). We set it SYNCHRONOUSLY on switch so an OLD sheet's in-flight load — which
  // could otherwise resolve after we switch but before the passive effect updates the
  // ref — is discarded instead of committing stale rows under the new tab.
  currentSheetIdRef: React.MutableRefObject<string | null>
}

// Remove a deleted sheet's browser-only state (localStorage). Server cascade handles
// the DB; these two keys are per-sheet client state that would otherwise leak. Wrapped
// in try/catch (localStorage throws in privacy mode). The keys:
// cubex-column-widths-${id} + cubex-pending-edits-${id}.
function clearSheetLocalStorage(sheetId: string) {
  try {
    localStorage.removeItem(`cubex-column-widths-${sheetId}`)
    localStorage.removeItem(`cubex-pending-edits-${sheetId}`)
  } catch { /* privacy mode — nothing we can do */ }
}

// Sheet (tab) CRUD + active-sheet reconciliation + optimism. Mirrors the optimistic
// patterns in useColumnRename (rename) and useColumnOps.handleColumnReorder (reorder
// serialization). Every server op returns the authoritative { sheets } list which we
// reconcile into table.sheets — this handles multi-tab / multi-device drift for free.
export const useSheetOps = ({
  table, setTable, activeSheet, setActiveSheet,
  currentUrlSheetId, navigateToSheet, waitForSaves, dropAllPending, setIsLoading, clearSheetData,
  currentSheetIdRef,
}: UseSheetOpsArgs) => {
  const tableId = table?.id ?? null
  // Live refs so a BACKGROUND result no-ops after the user navigated to another table.
  const tableIdRef = useRef<string | null>(tableId)
  tableIdRef.current = tableId
  const activeSheetRef = useRef<Sheet | null>(activeSheet)
  activeSheetRef.current = activeSheet

  const selectSeqRef = useRef(0)

  // Correctness model (kept deliberately simple for this 3-sheet, single-user case):
  //  - Server responses are AUTHORITATIVE and applied in arrival order (server always
  //    wins over local optimism).
  //  - A SETTLE-REFETCH runs once the in-flight mutation count returns to zero, so any
  //    out-of-order arrival is corrected by a final authoritative read. This avoids the
  //    divergence traps of trying to decide which response is "newer" (an older but
  //    committed response must NOT be discarded just because a newer op started).
  // Sheet-list reconciliation + coalesced settle-refetch extracted to its own hook
  // (keeps this file under the line cap). See useSheetReconcile for the correctness model.
  const { reconcileSheets, beginOp, endOp } = useSheetReconcile({
    setTable, activeSheetRef, setActiveSheet, tableIdRef,
  })


  // The SINGLE funnel for all sheet changes (clicks, create, delete, URL back/forward).
  // Robust to the URL having ALREADY moved before we run (browser back/forward).
  const selectSheet = useCallback(async (sheet: Sheet) => {
    // Same-sheet: no switch, but still repair a mismatched URL so a stale url can't linger.
    if (sheet.id === activeSheetRef.current?.id) {
      if (currentUrlSheetId !== sheet.id) navigateToSheet(sheet.id)
      return
    }
    const seq = ++selectSeqRef.current
    // Barrier: flush the OUTGOING sheet's pending edits before switching.
    const flushed = await waitForSaves(5000)
    if (seq !== selectSeqRef.current) return // superseded by a newer select
    if (!flushed) {
      toast.error("Couldn't save your pending edits; staying on this sheet.")
      // The URL may have already moved (back/forward). Restore it to the sheet we're
      // actually showing so URL and view don't desync.
      const current = activeSheetRef.current
      if (current && currentUrlSheetId !== current.id) navigateToSheet(current.id)
      return
    }
    // Set loading true SYNCHRONOUSLY with the sheet change so the grid-area loader is up
    // in the SAME render that activeSheet flips — the grid can't paint the old sheet's
    // rows under the new tab for a frame. The activeSheet effect re-sets it + loads; the
    // load's finally clears it (so a failed load doesn't stick the loader).
    setIsLoading(true)
    clearSheetData()
    // Point the load-discard ref at the NEW sheet NOW, so any in-flight OLD-sheet load
    // that resolves after this switch is discarded by useSheetLoad's guard.
    currentSheetIdRef.current = sheet.id
    setActiveSheet(sheet)
    if (currentUrlSheetId !== sheet.id) navigateToSheet(sheet.id)
  }, [currentUrlSheetId, navigateToSheet, waitForSaves, setActiveSheet, setIsLoading, clearSheetData, currentSheetIdRef])

  const createSheet = useCallback(async () => {
    if (!tableId) return
    beginOp()
    try {
      const res = await sheetsAPI.createSheet(tableId, { afterSheetId: activeSheetRef.current?.id })
      if (tableIdRef.current !== tableId) return // navigated away
      reconcileSheets(res.sheets)
      await selectSheet(res.sheet)
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to add sheet')
    } finally { endOp() }
  }, [tableId, beginOp, endOp, reconcileSheets, selectSheet])

  // Optimistic rename extracted to its own hook (keeps this file under the line cap,
  // mirroring how useColumnRename was split out of useColumnOps).
  const { renameSheet } = useSheetRename({
    table, setTable, activeSheetRef, setActiveSheet, tableIdRef, reconcileSheets, beginOp, endOp,
  })

  // OPTIMISTIC reorder. Optimistically reflect the drag immediately; the server response
  // (or the settle-refetch on failure) is authoritative. No per-op seq/gen bookkeeping —
  // the begin/end settle-refetch corrects any out-of-order arrival.
  const reorderSheets = useCallback(async (orderedSheetIds: string[]) => {
    if (!tableId) return
    const boundTableId = tableId
    setTable(prev => {
      if (!prev?.sheets) return prev
      const byId = new Map(prev.sheets.map(s => [s.id, s]))
      const next = orderedSheetIds.map(id => byId.get(id)).filter((s): s is Sheet => !!s)
      return next.length === prev.sheets.length ? { ...prev, sheets: next } : prev
    })
    beginOp()
    try {
      const res = await sheetsAPI.reorderSheets(boundTableId, orderedSheetIds)
      if (tableIdRef.current === boundTableId) reconcileSheets(res.sheets)
    } catch {
      toast.error('Failed to reorder sheets')
      // endOp's settle-refetch restores the authoritative order.
    } finally { endOp() }
  }, [tableId, setTable, beginOp, endOp, reconcileSheets])

  const deleteSheet = useCallback(async (sheetId: string) => {
    if (!tableId) return
    const boundTableId = tableId
    const preList = table?.sheets ?? []
    const deletedIdx = preList.findIndex(s => s.id === sheetId)
    // Re-read active status from the LIVE ref (not a value captured earlier) so an
    // active-sheet change mid-flight is respected. If the sheet being deleted is the
    // active one, flush its edits first.
    if (activeSheetRef.current?.id === sheetId) {
      const flushed = await waitForSaves(5000)
      if (!flushed) {
        toast.error("Couldn't save your pending edits; delete cancelled.")
        return
      }
    }
    beginOp()
    try {
      const res = await sheetsAPI.deleteSheet(boundTableId, sheetId)
      if (tableIdRef.current !== boundTableId) return
      // (a) reconcile to the post-delete authoritative list
      reconcileSheets(res.sheets)
      // (b) purge in-memory autosave state BEFORE the survivor switch so the dead
      //     sheet's queue can't block the post-delete selectSheet barrier
      dropAllPending(sheetId)
      // (c) clear browser-only state
      clearSheetLocalStorage(sheetId)
      // (d) ONLY switch survivors if the deleted sheet is STILL the active one now (the
      //     user may have switched tabs while DELETE was in flight — don't override a
      //     newer selection). Survivor computed from the RETURNED list (post-delete
      //     truth): right neighbor, else left, else first.
      if (activeSheetRef.current?.id === sheetId) {
        const survivor = res.sheets[deletedIdx] ?? res.sheets[deletedIdx - 1] ?? res.sheets[0]
        if (survivor) await selectSheet(survivor)
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to delete sheet')
    } finally { endOp() }
  }, [tableId, table, waitForSaves, beginOp, endOp, reconcileSheets, dropAllPending, selectSheet])

  return { selectSheet, createSheet, renameSheet, reorderSheets, deleteSheet }
}

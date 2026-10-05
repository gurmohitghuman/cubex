import { useCallback } from 'react'
import type { Sheet } from '@/utils/api'
import { CellChange, SavedCell, recentlySavedKey, pruneRecentlySaved } from './cellQueue'

interface UseQueueReconcileArgs {
  activeSheet: Sheet | null
  setUnsavedChanges: React.Dispatch<React.SetStateAction<CellChange[]>>
  pendingEditsRef: React.MutableRefObject<CellChange[]>
  recentlySavedRef: React.MutableRefObject<Map<string, SavedCell>>
  isPausedRef: React.MutableRefObject<() => boolean>
}

// Keeps the autosave queue (useCellOps) consistent with structural changes on
// the current sheet (row delete, column delete/rename, sort, CSV replace), in
// two steps: waitForSaves drains what's in flight, then the drop/rename
// helpers rewrite what hasn't flushed yet.
export const useQueueReconcile = ({
  activeSheet, setUnsavedChanges, pendingEditsRef, recentlySavedRef, isPausedRef,
}: UseQueueReconcileArgs) => {
  // Resolves true once the ACTIVE SHEET's pending autosaves have flushed; false
  // on timeout (e.g. offline, server 5xx). A barrier before operations that
  // rewrite row_index (physical sort) or remove rows/columns — an in-flight
  // cell PUT keyed on the old index/name would otherwise land wrong or
  // resurrect. Scoped to the active sheet on purpose: a terminally-failed edit
  // on a BACKGROUND sheet (status='error', never pruned) must not wedge sort/
  // rename/delete on the sheet the user is actually on. Mirrors the per-sheet
  // filtering useSheetLoad already does.
  const waitForSaves = useCallback((timeoutMs = 5000) => new Promise<boolean>(resolve => {
    const sheetId = activeSheet?.id
    const pendingForActive = () =>
      sheetId ? pendingEditsRef.current.filter(c => c.sheetId === sheetId).length : 0
    if (pendingForActive() === 0) return resolve(true)
    let start = Date.now()
    // Absolute ceiling, NOT reset by pause. The per-attempt `timeoutMs` clock is
    // reset while paused (a held pause legitimately freezes flushing), but a pause
    // that NEVER lifts — e.g. an in-flight rename request that hangs and leaves
    // setAutosavePaused(true) stuck — would otherwise reset the clock forever and
    // deadlock every later sort/delete/rename barrier. This hard cap guarantees
    // the barrier always RESOLVES (never hangs); it returns false and the caller
    // aborts the structural op safely. (A flush that only gets to start moments
    // before this deadline may not get its full timeoutMs — an acceptable trade
    // for the guaranteed-termination property; the caller handles false safely.)
    const hardDeadline = Date.now() + Math.max(timeoutMs * 4, 30000)
    const timer = setInterval(() => {
      if (pendingForActive() === 0) { clearInterval(timer); resolve(true) }
      else if (Date.now() > hardDeadline) { clearInterval(timer); resolve(false) }
      // A held pause (e.g. an in-flight column rename) intentionally freezes
      // flushing — the queue CAN'T drain until it lifts. That's not a stuck
      // save, so don't count paused time against the per-attempt timeout: keep
      // resetting that clock while paused (bounded by hardDeadline above). Once
      // unpaused, the real flush gets the full budget, and a genuinely-stuck
      // save still times out and aborts.
      else if (isPausedRef.current()) { start = Date.now() }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(false) }
    }, 50)
  }), [activeSheet])

  // Drop queued edits for rows/columns about to be structurally removed or
  // renamed on the CURRENT sheet. Called by row-delete / column-delete /
  // column-rename so a stale flush can't resurrect the deleted data (the
  // autosave PUT is an upsert that recreates rows and re-registers columns).
  // Each also prunes recentlySavedRef so the silent-reload overlay doesn't
  // visually re-create a just-removed cell from an acked-but-not-reloaded edit.
  const dropPendingForRows = useCallback((rowIndices: number[]) => {
    if (!activeSheet) return
    const sheetId = activeSheet.id
    const drop = new Set(rowIndices)
    setUnsavedChanges(prev =>
      prev.filter(c => !(c.sheetId === sheetId && drop.has(c.rowIndex))))
    pruneRecentlySaved(recentlySavedRef.current, e => e.sheetId === sheetId && drop.has(e.rowIndex))
  }, [activeSheet])

  const dropPendingForColumn = useCallback((columnName: string) => {
    if (!activeSheet) return
    const sheetId = activeSheet.id
    setUnsavedChanges(prev =>
      prev.filter(c => !(c.sheetId === sheetId && c.columnName === columnName)))
    pruneRecentlySaved(recentlySavedRef.current, e => e.sheetId === sheetId && e.columnName === columnName)
  }, [activeSheet])

  // Drop EVERY queued/acked edit for a sheet. Used before a CSV-replace import:
  // replace rewrites row_index 0,1,2… for entirely new rows AND bumps
  // row_generation, so any pending edit's (rowIndex, columnName) now addresses a
  // DIFFERENT logical row. Flushing it post-reload would land the value on the
  // wrong row (mode:'update' blocks resurrection, not a stray UPDATE onto a real
  // row). Caller passes the sheetId explicitly — import operates on the active
  // sheet, but the queue is sheet-stamped, so we drop by the same key.
  const dropAllPending = useCallback((sheetId: string) => {
    setUnsavedChanges(prev => prev.filter(c => c.sheetId !== sheetId))
    pruneRecentlySaved(recentlySavedRef.current, e => e.sheetId === sheetId)
  }, [])

  const renamePendingColumn = useCallback((oldName: string, newName: string) => {
    if (!activeSheet) return
    const sheetId = activeSheet.id
    setUnsavedChanges(prev => prev.map(c =>
      (c.sheetId === sheetId && c.columnName === oldName)
        ? { ...c, columnName: newName }
        : c))
    // Remap recently-saved overlay entries for the renamed column. Exact match
    // on the value object's columnName — no key-suffix decoding.
    for (const [key, e] of Array.from(recentlySavedRef.current.entries())) {
      if (e.sheetId === sheetId && e.columnName === oldName) {
        recentlySavedRef.current.delete(key)
        recentlySavedRef.current.set(
          recentlySavedKey(sheetId, e.rowIndex, newName),
          { ...e, columnName: newName },
        )
      }
    }
  }, [activeSheet])

  return { waitForSaves, dropPendingForRows, dropPendingForColumn, dropAllPending, renamePendingColumn }
}

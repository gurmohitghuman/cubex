import { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet, SheetData } from '@/utils/api'

interface UseRowOpsArgs {
  activeSheet: Sheet | null
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  // Keeps the loaded-rows window (the loadMore server offset) aligned after an
  // optimistic bulk delete, so the next "load more" doesn't skip rows.
  setLoadedRowsCount: React.Dispatch<React.SetStateAction<number>>
  rowGenerationRef: React.MutableRefObject<Map<string, number>>
  reloadActiveSheet: (opts?: { silent?: boolean }) => void
  waitForSaves: (timeoutMs?: number) => Promise<boolean>
  dropPendingForRows: (rowIndices: number[]) => void
}

// Row delete (bulk, optimistic, generation-fenced) and row add.
export const useRowOps = ({
  activeSheet, setSheetData, setLoadedRowsCount, rowGenerationRef, reloadActiveSheet, waitForSaves, dropPendingForRows,
}: UseRowOpsArgs) => {
  // Render-synced ref to the CURRENT active sheet id. handleDeleteRows runs
  // fire-and-forget (the confirm dialog closes immediately), so the user can
  // switch sheets during its waitForSaves + network round-trip. Its closure's
  // `activeSheet` is the sheet at call time, but setSheetData/setLoadedRowsCount
  // are sheet-agnostic and would apply optimistic removal to whatever sheet is
  // showing NOW — deleting the wrong rows from / corrupting the loaded-window
  // offset of sheet B. This ref lets the completion path bail when the user has
  // navigated away (server state is already correct; the abandoned sheet
  // re-syncs from server truth on its next load).
  const activeSheetIdRef = useRef<string | null>(activeSheet?.id ?? null)
  activeSheetIdRef.current = activeSheet?.id ?? null

  const handleDeleteRows = useCallback(async (rows: number[]) => {
    if (!activeSheet || rows.length === 0) return
    // Pin the sheet this delete targets. Used for the API call AND, at
    // completion, to detect whether the user has since switched sheets (the
    // dialog closes immediately, so the await window is fully interactive).
    const originSheetId = activeSheet.id
    const unique = Array.from(new Set(rows))
    // The two confirm dialogs (header-menu DeleteConfirms, topbar SheetModals)
    // both close immediately and fire this fire-and-forget, so ALL progress and
    // outcome feedback lives here. A single loading toast, updated in place by
    // `id`, is the "Deleting…" → "N deleted" / error indicator. EVERY exit path
    // below MUST resolve this id (success/error), or the spinner sticks forever
    // — including the pre-`try` flush-timeout return. The flush/drop preamble is
    // non-throwing (waitForSaves is resolve-only; dropPendingForRows is just
    // setState) and the network/optimistic work sits inside try/catch, so the
    // fire-and-forget can't leak an unhandled rejection that orphans the toast.
    const toastId = toast.loading(`Deleting ${unique.length} row${unique.length === 1 ? '' : 's'}…`)
    // Reconcile the autosave queue BEFORE deleting, or the upsert PUT
    // (INSERT … ON CONFLICT) resurrects a just-deleted row. Two distinct
    // hazards, two steps:
    //   1. waitForSaves() drains anything already IN FLIGHT or queued to the
    //      server — an in-flight PUT can't be recalled, so we must let it land
    //      first and then delete on top of it. (We can't simply discard those;
    //      the request is already on the wire.)
    //   2. dropPendingForRows() discards edits enqueued for these rows that
    //      have NOT yet flushed — we don't want them re-sent post-delete.
    // Order matters: flush first, then drop the stragglers. On a flush
    // timeout, abort the delete rather than risk a resurrection race.
    const flushed = await waitForSaves(5000)
    if (!flushed) {
      toast.error("Couldn't save your pending edits; delete cancelled. Check your connection and try again.", { id: toastId })
      return
    }
    dropPendingForRows(unique)
    // Single bulk-delete request — one HTTP call, one SQL transaction, no
    // rate-limit risk regardless of selection size. Server caps at 10k per
    // call (MAX_BULK_DELETE_ROWS), so chunk if the user somehow selects more.
    const CHUNK = 10000
    // A selection above 10k rows takes several chunks. On a mid-loop failure,
    // reloadActiveSheet() is the cheap, correct floor (no UI/server desync — see
    // the catch below); per-chunk optimistic removal + "deleted N of M" reporting
    // would be the nicer upgrade.
    let chunksAcked = 0
    try {
      let totalDeleted = 0
      // Fall back to 0 (the initial row_generation) if the ref hasn't been seeded
      // yet — bulk-delete now REQUIRES a generation server-side. If the real
      // generation has since advanced, the server 409s and we reload (catch below).
      const gen = rowGenerationRef.current.get(originSheetId) ?? 0
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK)
        const { deletedCount } = await sheetsAPI.bulkDeleteRows(originSheetId, chunk, gen)
        totalDeleted += deletedCount
        chunksAcked++
      }
      // The user may have switched sheets during the round-trip (fire-and-forget
      // delete, dialog already closed). The server delete on originSheetId
      // succeeded — report it — but DON'T apply optimistic removal to whatever
      // sheet is showing now: setSheetData/setLoadedRowsCount are sheet-agnostic
      // and would filter originSheet's row indices out of the wrong sheet and
      // corrupt its loadMore offset. The abandoned origin sheet re-syncs from
      // server truth on its next load, so skipping the local mutation is safe.
      if (activeSheetIdRef.current !== originSheetId) {
        toast.success(`${totalDeleted} row${totalDeleted === 1 ? '' : 's'} deleted`, { id: toastId })
        return
      }
      // Optimistic local removal — matches handleColumnDelete.
      // Previously this called reload(), which re-fetched the whole sheet and
      // remounted the grid (a visible "refresh"). loadedRowsCount is the loadMore
      // OFFSET — it must track the loaded-window size, so decrement it by the rows
      // ACTUALLY removed from the window, NOT totalDeleted (the server count).
      // These diverge when a selected index isn't in the window or the server
      // deleted fewer than selected (e.g. some already gone from another tab):
      // using totalDeleted then misaligns the offset and the next loadMore skips
      // or repeats rows. Compute the window-removal count inside the setSheetData
      // updater and read it from the setLoadedRowsCount updater: both are queued in
      // this handler tick and React runs queued updaters in order during the next
      // render, so removedFromWindow is set before it's read (and being a pure
      // function of prev, StrictMode's double-invoke is harmless). Keep both as
      // functional updaters — do NOT hoist removedFromWindow's read out of the
      // updater, or it reads the stale 0.
      const toRemove = new Set(unique)
      let removedFromWindow = 0
      setSheetData(prev => {
        if (!prev) return prev
        const kept = prev.data.rows.filter(r => !toRemove.has(r.rowIndex))
        removedFromWindow = prev.data.rows.length - kept.length
        return {
          ...prev,
          data: {
            ...prev.data,
            rows: kept,
            totalRows: Math.max(0, prev.data.totalRows - totalDeleted),
          },
        }
      })
      setLoadedRowsCount(prev => Math.max(0, prev - removedFromWindow))
      toast.success(`${totalDeleted} row${totalDeleted === 1 ? '' : 's'} deleted`, { id: toastId })
    } catch (error: any) {
      // Two distinct 409s from bulk-delete:
      //   1. An active AI/HTTP run on the sheet (no currentGeneration in the body).
      //      Deleting mid-run would orphan in-flight result writes — the user must
      //      stop/finish the run. No reload: their indices are still valid.
      //   2. A stale row_generation (currentGeneration present) — the sheet was
      //      reordered elsewhere, so our indices are stale and would hit the wrong
      //      rows. Recover by reloading. (Optimistic removal hasn't run yet — it's
      //      after the await — so the grid still shows the real rows.)
      if (error?.response?.status === 409) {
        const hasGen = typeof error?.response?.data?.currentGeneration === 'number'
        if (!hasGen) {
          toast.error(error?.response?.data?.error ?? 'Cannot delete rows while a run is active. Stop or finish the run first.', { id: toastId })
          return
        }
        // Only reload if still on the origin sheet — reloadActiveSheet targets
        // whatever sheet is current (currentSheetIdRef), so reloading after a
        // sheet switch would yank an unrelated sheet. The origin sheet, when
        // revisited, loads fresh anyway.
        if (activeSheetIdRef.current === originSheetId) {
          toast.error('This sheet was reordered in another tab. Reloaded. Re-select the rows to delete.', { id: toastId })
          reloadActiveSheet()
        } else {
          toast.error('Couldn\'t delete rows: the sheet was reordered in another tab.', { id: toastId })
        }
        return
      }
      console.error('Bulk delete rows error:', error)
      // If an EARLIER chunk already committed server-side before this one failed,
      // the optimistic removal below never ran, so the grid still shows rows that
      // are gone on the server. Reload to re-sync to server truth rather than leave
      // the UI lying. (Single-chunk failures — the only case under the live row cap
      // — deleted nothing, so the grid is already correct and no reload is needed.)
      // Same origin-sheet guard as above: only reload if we're still on it.
      if (chunksAcked > 0) {
        toast.error('Some rows were deleted before the request failed. Reloading to re-sync.', { id: toastId })
        if (activeSheetIdRef.current === originSheetId) reloadActiveSheet()
        return
      }
      toast.error('Failed to delete rows', { id: toastId })
    }
  }, [activeSheet, setSheetData, setLoadedRowsCount, dropPendingForRows, waitForSaves, rowGenerationRef, reloadActiveSheet])

  // Append N blank rows. Mirrors useColumnOps.handleAddColumn: call the API,
  // optimistically append, no reload, no success toast (the rows appear at once).
  // The server inserts at MAX(row_index)+1 .. +N ≥ every loaded index, so
  // appending to the end preserves row_index order. We bump totalRows but NOT
  // loadedRowsCount — that's the loadMore server offset; the loadMore
  // dedupe-by-rowIndex reconciles any later overlap.
  const handleAddRows = useCallback(async (count: number) => {
    if (!activeSheet) return
    try {
      const { rowIndexes } = await sheetsAPI.addRows(activeSheet.id, count)
      if (rowIndexes.length === 0) return
      setSheetData(prev => prev ? {
        ...prev,
        data: {
          ...prev.data,
          rows: [...prev.data.rows, ...rowIndexes.map(rowIndex => ({ rowIndex, data: {} }))],
          totalRows: prev.data.totalRows + rowIndexes.length,
        },
      } : prev)
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to add rows')
    }
  }, [activeSheet, setSheetData])

  return { handleDeleteRows, handleAddRows }
}

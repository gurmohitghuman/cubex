import { useEffect, useRef } from 'react'
import { Sheet, SheetData } from '@/utils/api'
import { INITIAL_ROW_LOAD } from '@/lib/constants'

// Refill the loaded row window when a bulk delete leaves it too small while rows
// still exist server-side. Two shapes of the same problem:
//   - Window EMPTIED (deleted every loaded row of a larger sheet): an empty grid
//     fires no scroll event, so loadMore never triggers. LOUD reload (bumps
//     loadGenRef, invalidating any stale in-flight loadMore).
//   - Window UNDERFILLED (deleted all-but-a-few — e.g. select-all minus one):
//     the survivors don't fill the viewport, so there's no scrollbar and
//     onBodyScrollEnd never fires either — the user sees only the kept rows
//     until a manual refresh. SILENT reload: the grid stays mounted and the
//     surviving rows just appear under the kept ones. A reload (not a loadMore
//     append) on purpose: loadMoreData no-ops while a scroll-triggered page is
//     mid-flight, which would strand this one-shot refill; loadSheetData always
//     runs, and its commitSeq bump makes loadMoreData discard that stale page
//     (fetched at a pre-delete ordinal offset) instead of merging it.
// "Underfilled" = fewer than INITIAL_ROW_LOAD rows loaded. That constant already
// means "covers first paint on any screen" — a window at least that tall always
// has a scrollbar, so normal scroll-driven loadMore takes over from there.
//
// LOOP GUARD: we record the (sheetId, totalRows, rows.length) we LAST attempted
// a refill for and refuse to retry the same window state. Without this, a refill
// GET that fails — loadSheetData swallows the error — or one that legitimately
// comes back still short (transient server inconsistency) would re-satisfy the
// condition and spin the client in an infinite reload loop. A
// genuinely-new state (rows arrived, totalRows changed, or the sheet switched)
// clears the guard so a later legitimate refill still runs.
export function useRowWindowRefill(
  activeSheet: Sheet | null,
  isLoading: boolean,
  sheetData: SheetData | null,
  reloadActiveSheet: (opts?: { silent?: boolean }) => Promise<void> | void,
) {
  // The window state we've already tried to refill, as `${sheetId}:${totalRows}:${rows}`.
  const attemptedRef = useRef<string | null>(null)
  // True only while a refill GET is in flight (prevents a double fire mid-request).
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!activeSheet || isLoading || !sheetData || inFlightRef.current) return
    const { rows, totalRows } = sheetData.data
    if (rows.length >= totalRows || rows.length >= INITIAL_ROW_LOAD) {
      // Window is healthy (everything loaded, or tall enough to scroll) — clear
      // the guard so a FUTURE shrunken-window event (another delete) can refill.
      attemptedRef.current = null
      return
    }
    // Underfilled: refill — but only ONCE per distinct window state, so a
    // still-short result can't loop.
    const key = `${activeSheet.id}:${totalRows}:${rows.length}`
    if (attemptedRef.current === key) return
    attemptedRef.current = key
    inFlightRef.current = true
    const refill = reloadActiveSheet(rows.length > 0 ? { silent: true } : undefined)
    Promise.resolve(refill).finally(() => { inFlightRef.current = false })
  }, [activeSheet, isLoading, sheetData, reloadActiveSheet])
}

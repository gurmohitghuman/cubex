// Over 200 lines: one load path whose ordering guards (load generation, commit
// sequence, structural barriers) only make sense read together.
import { useCallback, useRef } from 'react'
import { sheetsAPI, Sheet, SheetData, AIRun, HTTPRun } from '@/utils/api'
import toast from 'react-hot-toast'
import { INITIAL_ROW_LOAD } from '@/lib/constants'
import { overlayLocalEdits, PendingEdit, SavedCell } from './silentReloadOverlay'
import { useSheetLoadMore } from './useSheetLoadMore'
import { useStructuralBarriers } from './useStructuralBarriers'
import { applyLoadedView } from './applyLoadedView'
import { commitMergedWindow, fetchWindow } from './reloadWindow'

interface UseSheetLoadArgs {
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>
  setLoadedRowsCount: React.Dispatch<React.SetStateAction<number>>
  setColumnOrder: (cols: string[]) => void
  setEmptyFilter: (f: Record<string, 'empty' | 'not_empty'>) => void
  setColumnFilters: (f: Record<string, { type: 'contains'; value: string }>) => void
  fetchActiveHTTPRuns: (sheetId: string) => Promise<HTTPRun[]> | void
  fetchActiveAIRuns: (sheetId: string) => Promise<AIRun[]> | void
  reconnectToActiveRuns: (sheetId: string) => Promise<void> | void
  // Cleared on every LOUD (non-silent) load. A loud load remounts the grid
  // (FullPageLoader swap) so its internal selection is gone, but AG Grid fires
  // no selectionChanged on remount — the stale parent selection (by row_index)
  // would otherwise survive sort/import and drive a delete against wrong rows.
  clearSelection: () => void
  // Live (render-synced) ref to the autosave queue, so a SILENT reload can
  // overlay un-flushed edits onto the fetched rows instead of clobbering them.
  pendingEditsRef: React.MutableRefObject<PendingEdit[]>
  // Edits whose PUT was acked but a loud reload hasn't re-fetched yet. The
  // optimistic value lives only in the old sheetData, so a silent reload's flat
  // replace would lose it unless we overlay it too. The map value carries the
  // structured fields (we never parse the key). Self-cleaned here once the
  // server GET carries the value or the entry ages past RECENTLY_SAVED_TTL_MS.
  recentlySavedRef: React.MutableRefObject<Map<string, SavedCell>>
  // The sheet currently being viewed. A load whose response no longer matches
  // this (the user switched sheets mid-fetch) is discarded instead of clobbering.
  currentSheetIdRef: React.MutableRefObject<string | null>
  // sheetId → row_generation the tab last COMMITTED (reseeded from every
  // committed payload in SheetPage). Read by the silent-commit gate below.
  rowGenerationRef: React.MutableRefObject<Map<string, number>>
  activeSheet: Sheet | null
  loadedRowsCount: number
}

export const useSheetLoad = ({
  setSheetData,
  setIsLoading,
  setLoadedRowsCount,
  setColumnOrder,
  setEmptyFilter,
  setColumnFilters,
  fetchActiveHTTPRuns,
  fetchActiveAIRuns,
  reconnectToActiveRuns,
  clearSelection,
  pendingEditsRef,
  recentlySavedRef,
  currentSheetIdRef,
  rowGenerationRef,
  activeSheet,
  loadedRowsCount,
}: UseSheetLoadArgs) => {
  // Monotonic load token. Every loadSheetData call bumps it and captures its own
  // value; before committing fetched data to state it checks the token is still
  // current. A later load (sheet switch, sort reload, another refresh) supersedes
  // an in-flight one, so a slow response from the PREVIOUS sheet/load can't land
  // on top of the new one (the H6 stale-response-clobber bug).
  const loadGenRef = useRef(0)
  // Separate monotonic sequence for SILENT loads. Silent loads deliberately do
  // NOT bump loadGenRef (so they can't strand a loud load's spinner — see
  // below), which means two concurrent silent loads share the same loadGen and
  // BOTH pass the supersede guard. A slow silent load could then commit on top
  // of a newer one and, worse, after the newer one already self-cleaned the
  // recently-saved overlay it would re-paint a stale pre-edit value (lost edit).
  // This token orders silent commits among themselves: a silent load captures
  // it at start and discards its result if a later silent load has since run.
  const silentSeqRef = useRef(0)
  // sheetId → structural-barrier depth; see useStructuralBarriers.
  const {
    structuralBarrierRef, beginStructuralBarrier, endStructuralBarrier, isStructuralBarrierActive,
  } = useStructuralBarriers()

  // `limit` is in ROWS (server paginates by rows now). INITIAL_ROW_LOAD (300) covers
  // first paint (AG Grid paints ~viewport+rowBuffer); load-more fetches the next page
  // on scroll-end.
  //
  // opts.silent: refresh the data WITHOUT flipping isLoading — SheetPage swaps
  // the whole tree for a FullPageLoader while isLoading, which unmounts the
  // grid (scroll position, selection, in-progress edits all lost). Background
  // refreshes (run completion, Stop) use silent; user-initiated loads stay loud.
  //
  // opts.keepWindow (silent only): a background refresh of the held window
  // (reloadWindow.ts): `limit` may exceed one server page (fetched in pages, all
  // from one data_version or discarded), and a slice at offset > 0 is MERGED into
  // the held rows instead of replacing them, so the viewport doesn't move.
  const loadSheetData = useCallback(async (
    sheetId: string, limit = INITIAL_ROW_LOAD, offset = 0,
    opts?: { silent?: boolean; keepWindow?: boolean; keepTail?: boolean },
  ) => {
    const silent = opts?.silent === true
    const keepWindow = silent && opts?.keepWindow === true
    // Refuse a SILENT dispatch while a structural barrier runs for this sheet —
    // BEFORE the commit-seq bump below: dispatched, it would supersede the
    // barrier's own loud reload (which then discards at commit) while itself
    // dying at the commit gate — nobody commits and the tab strands on the
    // pre-sort snapshot. The commit-time gate further down
    // stays as defense for requests already in flight when the barrier rises;
    // the barrier's ending loud reload (or deferred silent reload) converges
    // whatever this refused load would have fetched.
    if (silent && (structuralBarrierRef.current.get(sheetId) ?? 0) > 0) return
    // Only a SPINNER-OWNING loud load (loud AND targeting the current sheet)
    // claims a new loadGenRef token. Silent refreshes and non-owning loud loads
    // just READ the current one. Rationale: the token invalidates the current
    // sheet's in-flight load and its spinner, so only a load that also SETS +
    // CLEARS that spinner may claim it. A silent load never clears isLoading, and
    // a non-owning loud load (wrong sheet) can clear neither — either would strand
    // the real load's spinner if it bumped the token. So a loud load's token can
    // only be invalidated by another SPINNER-OWNING loud load, which does clear.
    // A loud load only "owns the spinner" if it targets the CURRENT sheet. A
    // pinned reload (e.g. the post-sort reloadSheet closes over the sort-time
    // sheet) can fire for sheet A after the user switched to B. Such a
    // non-owning loud load must NOT claim a loadGenRef token: doing so would
    // supersede B's real load, B would discard its own response, and neither A
    // (not current) nor B (superseded) would clear isLoading — B strands behind
    // an infinite "Loading spreadsheet…". So a non-owning loud load reads the
    // current token like a silent load (it can commit its data if still valid,
    // but never invalidates the current sheet's load or its spinner).
    const ownsSpinner = !silent && currentSheetIdRef.current === sheetId
    const myGen = ownsSpinner ? ++loadGenRef.current : loadGenRef.current
    // Commit-ordering token bumped by EVERY load. Whichever load STARTS last
    // owns the final committed data; any load that finishes after a newer one
    // is discarded at commit. Separate from loadGenRef (which only spinner-
    // owning loads bump) so it can order a slow load vs. a newer non-bumping one.
    const myCommitSeq = ++silentSeqRef.current
    if (ownsSpinner) {
      setIsLoading(true)
      // Row selection is keyed by row_index; a loud reload remounts the grid and
      // invalidates it (sort even rewrites row_index). Clear it here so the
      // header "Delete (N)" button can't act on a stale, now-wrong selection.
      clearSelection()
      // A loud reload re-fetches the whole window verbatim, so any acked edit is
      // now reconciled — drop this sheet's recently-saved overlay entries so they
      // don't linger and over-overlay a later silent reload.
      for (const [key, e] of Array.from(recentlySavedRef.current.entries())) {
        if (e.sheetId === sheetId) recentlySavedRef.current.delete(key)
      }
    }
    // Only the load that actually set the spinner arms the safety timeout —
    // a non-owning loud load must not later clear a spinner it never showed.
    // The callback re-checks the SAME ownership condition as the finally clause:
    // 30s is long enough that the user may have switched sheets, superseding
    // this load; firing setIsLoading(false) then would clear the NEW sheet's
    // live spinner. Only clear if this load still owns the current spinner.
    const loadingTimeout = ownsSpinner ? setTimeout(() => {
      if (myGen === loadGenRef.current && currentSheetIdRef.current === sheetId) {
        console.warn('⚠️ Loading timeout reached for sheet:', sheetId)
        setIsLoading(false)
      }
    }, 30000) : null

    try {
      const data = keepWindow
        ? await fetchWindow(sheetsAPI.getData, sheetId, offset, limit)
        : await sheetsAPI.getData(sheetId, limit, offset)
      if (!data) return // pages straddled a change: the change poll reloads again
      // Discard a superseded or wrong-sheet response: if a later load bumped the
      // token, or the user switched sheets while this fetch was in flight, do NOT
      // commit it — it would clobber the current sheet's state with stale data.
      if (myGen !== loadGenRef.current || currentSheetIdRef.current !== sheetId) return
      // Discard ANY load (loud or silent) that a newer load has since superseded.
      // Critically this also catches a slow LOUD load returning after a newer
      // SILENT one: loadGenRef wouldn't flag it (silent didn't bump loadGenRef),
      // so without this the loud load re-paints stale data — and after the silent
      // load self-cleaned the recently-saved overlay, that stale paint silently
      // drops a just-acked edit.
      if (myCommitSeq !== silentSeqRef.current) return
      // Refuse SILENT commits while a structural barrier runs for this sheet.
      // A silent load STARTED mid-barrier (run-completion refresh, Stop
      // refetch — not just the change-poll) captures the post-bump commit seq,
      // so the invalidation above can't stop it; committing here would overlay
      // old-generation pending edits onto post-sort data and reseed
      // rowGenerationRef, making the barrier skip its loud reload. Discarding
      // is safe: the barrier ends in a loud reload (which refetches what this
      // load carried), or holds the target generation already. Loud commits
      // stay allowed — the barrier's own recovery reload is loud.
      if (silent && (structuralBarrierRef.current.get(sheetId) ?? 0) > 0) return
      // Also refuse a SILENT commit whose payload carries a DIFFERENT
      // row_generation than the tab last committed — the PRE-DISCOVERY window:
      // an external sort can land between this load's dispatch and the change-
      // poll raising the barrier, so the barrier gate above sees nothing wrong,
      // yet committing would overlay old-generation pending edits onto
      // post-sort rows AND reseed rowGenerationRef so the poll's structural
      // handler then skips its loud reload ("holds target generation" proven
      // by exactly this unsafe commit). The generation move
      // always reaches the poll, whose fenced loud path owns that transition.
      const heldGen = rowGenerationRef.current.get(sheetId)
      if (silent && heldGen !== undefined && (data.sheet.row_generation ?? 0) !== heldGen) return
      // Silent (background) reloads must not clobber the user's edits — overlay
      // un-flushed + acked-but-not-reloaded values onto the fetched rows, with
      // self-cleaning of reconciled entries (rationale in silentReloadOverlay).
      if (silent) overlayLocalEdits(data, sheetId, pendingEditsRef.current, recentlySavedRef.current)
      if (keepWindow) {
        commitMergedWindow(setSheetData, setLoadedRowsCount, data, { offset, limit, keepTail: !!opts?.keepTail })
      } else setSheetData(data)

      applyLoadedView(data, offset,
        { setEmptyFilter, setColumnFilters, setLoadedRowsCount, setColumnOrder }, keepWindow)

      const sideLoads: Array<[string, () => Promise<unknown> | unknown]> = [
        ['active HTTP runs', () => fetchActiveHTTPRuns(sheetId)],
        ['active AI runs', () => fetchActiveAIRuns(sheetId)],
        ['active runs reconnect', () => reconnectToActiveRuns(sheetId)],
      ]
      for (const [label, fn] of sideLoads) {
        try { await fn() } catch (error) { console.error(`⚠️ Failed: ${label}`, error) }
      }
    } catch (error: any) {
      console.error('❌ Critical error in loadSheetData:', error)
      toast.error('Failed to load sheet data')
    } finally {
      if (loadingTimeout) clearTimeout(loadingTimeout)
      // Only the load that actually SET the spinner may clear it — gate on
      // ownsSpinner (captured at start), NOT `!silent`. A non-owning loud load
      // (wrong sheet at start) never set isLoading; if the user switched back to
      // its sheet before the real load's effect ran, a `!silent` check could let
      // this stale load clear a spinner it never owned. A superseded owning load
      // (myGen stale) also must not clear — that would dismiss the winning
      // load's spinner early. So: owned it, still newest, still current.
      if (ownsSpinner && myGen === loadGenRef.current && currentSheetIdRef.current === sheetId) {
        setIsLoading(false)
      }
    }
  }, [
    setSheetData, setIsLoading, setLoadedRowsCount, setColumnOrder,
    fetchActiveHTTPRuns, fetchActiveAIRuns, reconnectToActiveRuns,
    clearSelection, pendingEditsRef, recentlySavedRef, currentSheetIdRef,
  ])

  const { loadMoreData } = useSheetLoadMore({
    activeSheet, loadedRowsCount, setSheetData, setLoadedRowsCount,
    currentSheetIdRef, loadGenRef, silentSeqRef,
  })

  // Discard every IN-FLIGHT load at commit time by bumping the commit-ordering
  // token. Called at structural-barrier start (rationale at the call site in
  // useLiveSheetUpdates): a request already ON THE WIRE evades dispatch-time
  // gating; only a commit-time check reaches it. A discarded LOUD load still
  // clears its spinner (the finally clause gates on loadGenRef, not commit-seq).
  const invalidateInFlightLoads = useCallback(() => { ++silentSeqRef.current }, [])

  return {
    loadSheetData, loadMoreData, invalidateInFlightLoads,
    beginStructuralBarrier, endStructuralBarrier, isStructuralBarrierActive,
  }
}

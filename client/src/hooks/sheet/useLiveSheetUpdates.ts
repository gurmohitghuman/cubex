import React from 'react'
import toast from 'react-hot-toast'
import { useSheetChangePoll, ChangeBaseline } from './useSheetChangePoll'
import { shouldLoudReloadAfterBarrier } from './liveUpdateDecision'

// Minimum gap between silent reloads of the same sheet. A "silent reload" is
// NOT one request — loadSheetData fans out to ~6 (sheet data + AI results +
// run lists + reconnect, see useSheetLoad sideLoads), so budget on that.
// With the change-poll's 3s cycle floor (useSheetChangePoll), worst-case tab
// traffic under a write storm is ~20 polls + 4×6 reload requests ≈ 44/min —
// leaving a third of the global IP limiter's ~66/min average budget for
// autosaves and normal use (8s here penciled out to 978/1000 per
// 15min window, i.e. no headroom at all).
const SILENT_RELOAD_MIN_GAP_MS = 15_000

// Decides HOW an open tab reacts to the change-poll (useSheetChangePoll):
//
//   structural — row_generation moved: a sort / CSV-replace elsewhere re-meant
//   every row_index this tab holds. FIRST run the waitForSaves barrier: any
//   un-flushed autosave edits flush under the OLD generation, so the server's
//   row_generation fence 409s them and the EXISTING recovery (drop queue +
//   loud reload + toast) handles the conflict — without this, the loud reload
//   below would reseed rowGenerationRef and the queued old-index edits would
//   later flush "successfully" onto the WRONG post-sort rows.
//   BUT the barrier can also TIME OUT (return false) — when the autosave queue
//   is frozen in its error state (max retries hit, "Save failed · Retry" pill),
//   the edits never flush and never 409, so the 409 recovery never fires. In
//   that case we must DROP the frozen queue (+ toast) ourselves before the loud
//   reload reseeds rowGenerationRef; otherwise those stale-index edits would
//   later flush under the NEW generation and land on the wrong rows (P1-2).
//   Then loud-reload (grid remount clears the stale selection, drops overlays,
//   reseeds rowGenerationRef) unless the tab already holds that generation
//   (it caused the change itself, or the 409 recovery already reloaded).
//
//   data-only — data_version moved (appends / edits / deletes / column adds
//   via webhook or /api/v1) → the proven SILENT reload, which overlays
//   un-flushed + recently-acked local edits and syncs columns via
//   setColumnOrder (see useSheetLoad).
export function useLiveSheetUpdates(args: {
  // The LOADED sheet payload (sheetData.sheet) — its id keys the poll and its
  // versions seed the baseline, so the poll watches exactly what the tab renders.
  sheet: { id: string; row_generation?: number; data_version?: number } | null
  rowGenerationRef: React.MutableRefObject<Map<string, number>>
  // Which sheet the tab is currently showing. A poll queued for sheet A must not
  // drop-queue or loud-reload after the user has navigated to sheet B.
  currentSheetIdRef: React.MutableRefObject<string | null>
  waitForSaves: (timeoutMs?: number) => Promise<boolean>
  // Purge the sheet's pending + recently-acked autosave edits (no toast of its
  // own) — used to discard a frozen queue before a structural reload reseeds the
  // generation.
  dropAllPending: (sheetId: string) => void
  reloadActiveSheet: () => Promise<void> | void
  silentReload: (sheetId: string) => Promise<void> | void
  // useSheetLoad's commit-time kill switch: bumps the commit-ordering token so
  // any load already ON THE WIRE is discarded when it returns. Called at
  // structural-barrier start — dispatch-time gating (below) can't reach those.
  invalidateInFlightLoads: () => void
  // The structural-barrier registry lives in useSheetLoad (its commit path
  // gates EVERY silent caller on it, not just this hook's scheduler). This
  // hook raises/lowers it around the waitForSaves barrier below.
  beginStructuralBarrier: (sheetId: string) => void
  endStructuralBarrier: (sheetId: string) => void
  isStructuralBarrierActive: (sheetId: string) => boolean
  // The tab-list check riding the same poll (see useSheetChangePoll).
  sheetList?: { key: string | null | undefined; onChanged: () => void }
}) {
  const {
    sheet, rowGenerationRef, currentSheetIdRef, waitForSaves, dropAllPending, reloadActiveSheet, silentReload,
    invalidateInFlightLoads, beginStructuralBarrier, endStructuralBarrier, isStructuralBarrierActive, sheetList,
  } = args
  const baseline: ChangeBaseline | null = sheet
    ? { dataVersion: sheet.data_version ?? 0, rowGeneration: sheet.row_generation ?? 0 }
    : null

  // Silent reloads are COALESCED per sheet (leading + trailing edge, min
  // SILENT_RELOAD_MIN_GAP_MS apart). A sustained external writer (API/MCP
  // agent at its 120/min budget) resolves the change-poll on almost every
  // cycle; reloading per event stacked overlapping full-sheet GETs and burned
  // the tab's global-IP-limiter budget (observed 429 lockout of the owner's
  // own UI). One trailing reload converges on the final state — data_version
  // is cumulative, so skipped intermediates are never missed. The first
  // change after quiet fires immediately (single-edit latency unchanged).
  const silentReloadRef = React.useRef(silentReload)
  silentReloadRef.current = silentReload
  const lastSilentReloadAtRef = React.useRef<Map<string, number>>(new Map())
  const pendingSilentReloadRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  React.useEffect(() => () => {
    for (const t of pendingSilentReloadRef.current.values()) clearTimeout(t)
    pendingSilentReloadRef.current.clear()
  }, [])
  // Silent reloads are DEFERRED while a structural barrier runs for that sheet
  // (barrier state owned by useSheetLoad — see isStructuralBarrierActive).
  // A data-only change landing mid-barrier would otherwise dispatch a silent
  // load of POST-sort data that overlays old-generation pending edits and
  // reseeds rowGenerationRef — the structural handler then believes it already
  // holds the target generation, skips the loud reload, and the queued
  // stale-index edits flush onto the wrong rows (same class as
  // P1-2). Deferred, it re-schedules after the barrier resolves so the
  // data-only change is still converged.
  const deferredSilentReloadRef = React.useRef<Set<string>>(new Set())
  const scheduleSilentReload = (id: string) => {
    if (isStructuralBarrierActive(id)) {
      deferredSilentReloadRef.current.add(id)
      return
    }
    if (pendingSilentReloadRef.current.has(id)) return // queued reload already covers this change
    const fire = () => {
      pendingSilentReloadRef.current.delete(id)
      // A trailing timer can outlive navigation; reloading a sheet the tab no
      // longer shows is wasted budget (switching back loud-loads fresh anyway).
      if (currentSheetIdRef.current !== id) return
      lastSilentReloadAtRef.current.set(id, Date.now())
      void silentReloadRef.current(id)
    }
    const wait = (lastSilentReloadAtRef.current.get(id) ?? 0) + SILENT_RELOAD_MIN_GAP_MS - Date.now()
    if (wait <= 0) fire()
    else pendingSilentReloadRef.current.set(id, setTimeout(fire, wait))
  }
  useSheetChangePoll(sheet?.id ?? null, baseline, (id, change) => {
    if (change.structural) {
      // Cancel any queued silent reload FIRST: left armed, it could fire during
      // the waitForSaves barrier below and overlay old-generation pending edits
      // onto post-sort data — the exact race the loud path exists to prevent.
      // The cancelled timer represented an un-converged data-only change, so
      // mark it deferred — every exit below (including the early return) drains
      // the flag, or the tab could sit stale until the next external write.
      const pending = pendingSilentReloadRef.current.get(id)
      if (pending !== undefined) {
        clearTimeout(pending)
        pendingSilentReloadRef.current.delete(id)
        deferredSilentReloadRef.current.add(id)
      }
      void (async () => {
        // Raise the barrier BEFORE the first await — both this hook's
        // scheduler (defers) and useSheetLoad's commit gate (discards silent
        // commits) must see it as already up when the next change or response
        // arrives.
        beginStructuralBarrier(id)
        // Kill loads already ON THE WIRE (commit-time): a silent GET dispatched
        // before this structural event can return mid-barrier carrying post-sort
        // data — it would overlay old-generation pending edits and reseed
        // rowGenerationRef so the loud reload below gets skipped.
        // The barrier gate can't reach it (it captured pre-barrier state at
        // dispatch); the commit-seq bump can.
        invalidateInFlightLoads()
        try {
        if (rowGenerationRef.current.get(id) === change.rowGeneration) return
        const flushed = await waitForSaves()
        // Barrier timed out → the queue is frozen (edits never flushed, so the
        // 409 recovery below will never fire). Drop those stale-index edits now,
        // BEFORE the reload reseeds rowGenerationRef, or they'd later flush under
        // the new generation onto the wrong rows (P1-2).
        const dropped = !flushed
        if (dropped) {
          dropAllPending(id)
          toast.error('Unsaved edits could not be saved before the sheet was reordered elsewhere. Please re-enter them.')
        }
        // Decision (unit-tested in shouldLoudReloadAfterBarrier): reload only if
        // the tab still shows this sheet, and either we dropped a frozen queue
        // (reload UNCONDITIONALLY to clear any stale silent-reload overlay — the
        // race) or we don't already hold the target generation.
        const doReload = shouldLoudReloadAfterBarrier({
          dropped,
          isCurrentSheet: currentSheetIdRef.current === id,
          holdsTargetGeneration: rowGenerationRef.current.get(id) === change.rowGeneration,
        })
        if (doReload) await reloadActiveSheet()
        } finally {
          endStructuralBarrier(id)
          // Last barrier down: a data-only change arrived mid-barrier and was
          // deferred — converge it now (cheap if the loud reload above already
          // fetched it: the reload is paced by the gap and fenced at commit).
          if (!isStructuralBarrierActive(id) && deferredSilentReloadRef.current.delete(id)) {
            scheduleSilentReload(id)
          }
        }
      })()
    } else {
      scheduleSilentReload(id)
    }
  }, sheetList)
}

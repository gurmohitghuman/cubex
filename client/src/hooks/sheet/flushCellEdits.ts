import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI } from '@/utils/api'
import { CELL_MAX_BASIC, SHEET_BUSY_RETRY_MS } from '@/lib/constants'
import { RetryLaterError } from '@/hooks/useAutosave'
import { CellChange, SavedCell, recentlySavedKey, isNonRetryableStatus, cellMatches } from './cellQueue'

interface FlushContext {
  recentlySavedRef: MutableRefObject<Map<string, SavedCell>>
  setUnsavedChanges: Dispatch<SetStateAction<CellChange[]>>
  // Loud (409 recovery) or silent (skipped/oversize resync) reload.
  reloadActiveSheet: (opts?: { silent?: boolean }) => void
}

// The autosave flush for the cell-edit queue: useCellOps hands it to
// useAutosave as `save`. Sends each (sheet, edit-time generation) group as one
// PUT /:id/data and settles every outcome. Throws only on transient failures,
// so useAutosave backs off and retries those.
export async function flushCellEdits(
  items: CellChange[],
  { recentlySavedRef, setUnsavedChanges, reloadActiveSheet }: FlushContext,
): Promise<void> {
  // Group by the originating (sheetId, EDIT-TIME generation) stamped at
  // enqueue — never activeSheet or the CURRENT rowGenerationRef, both of
  // which can have moved since. Sheet stamping keeps a flush on its own
  // sheet; generation stamping keeps a stale-index edit honest: a reload
  // that reseeded the ref between edit and flush must not bless it (the
  // server fence 409s the stale group; the current ref would sneak it
  // past the fence onto the wrong post-sort rows).
  const bySheet = new Map<string, CellChange[]>()
  for (const item of items) {
    const key = `${item.sheetId}\x00${item.generation ?? ''}`
    const list = bySheet.get(key)
    if (list) list.push(item)
    else bySheet.set(key, [item])
  }
  // Strip sheetId from the wire payload — the server takes it from the URL.
  // Send the row_generation we last saw so the server can fence a stale-index
  // write (409) after a sort/replace elsewhere. allSettled (not all) so one
  // group's failure doesn't reject the others. Per group, three outcomes:
  //   - ack         → record "recently saved" (for the silent-reload overlay)
  //   - 409 busy    → the sheet is mid-sort/import (server lib/sheet-busy.ts):
  //                   keep everything queued and send it again shortly
  //   - 409         → stale index; reload (those indices are unrecoverable)
  //   - other 4xx   → DETERMINISTIC: drop the group + toast the server msg,
  //                   so it can't poison the queue and re-flush forever
  //   - 5xx/network → TRANSIENT: re-throw so useAutosave backs off & retries
  // Record "recently saved" ONLY for groups that actually ACKED — a 409'd or
  // dropped group's edits target rows we won't keep; recording them would let
  // a later silent reload re-overlay a value we never persisted.
  let hadConflict = false
  let busy = false
  const conflictDropped: CellChange[] = []
  const dropped: CellChange[] = []
  let dropMessage = ''
  // Edits the server dropped because an active AI/HTTP run owns the target
  // column (sheets-data.ts → getLockedRunColumns). The run is the authoritative
  // writer there until it ends; our edit would race the worker's per-row write.
  // The request still 200'd (other columns saved), so these arrive as a
  // `lockedColumns` list, not an error — collected here, purged + toasted below.
  const lockedDropped: CellChange[] = []
  const lockedColNames = new Set<string>()
  // Edits the server SKIPPED because their row/column no longer exists (the
  // view is stale — another tab deleted the row/column). The PUT 200s for the
  // surviving cells, returning these identities. We must NOT treat a skipped
  // no-op as saved: that would drop the user's only copy AND leave the value
  // re-flushing forever. Purge them + resync via a silent reload (below).
  const skippedDropped: CellChange[] = []
  // Edits the server DROPPED for exceeding the basic-cell size cap (manual
  // >8k that bypassed the client pre-guard — legacy/programmatic). Purge +
  // toast, same as skipped.
  const oversizeDropped: CellChange[] = []
  const at = Date.now()
  const results = await Promise.allSettled(
    Array.from(bySheet.values()).map((group) =>
      sheetsAPI.updateData(
        group[0].sheetId,
        group.map(({ rowIndex, columnName, value }) => ({ rowIndex, columnName, value })),
        // The EDIT-TIME generation (uniform within the group — it's part of
        // the group key). undefined (edited before the ref was seeded) keeps
        // the legacy skip-the-fence behavior.
        group[0].generation,
        // UPDATE-ONLY: grid cell edits must never create a row/column. The
        // generation fence + queue reconciliation handle most stale-write
        // cases; this is the structural backstop so any path that slips past
        // them can't resurrect deleted structure. A skipped cell (row/column
        // gone) is a no-op here; the silent-reload overlay corrects the view.
        'update',
      ).then(({ lockedColumns, skippedCells, oversizeCells }) => {
        const locked = new Set(lockedColumns)
        // Skipped cells (stale row/column) keyed for O(1) lookup. These did
        // NOT persist — exclude them from "recently saved" and purge below.
        const skippedSet = new Set(
          skippedCells.map(c => `${c.rowIndex}\x00${c.columnName}`),
        )
        // Oversize cells the server DROPPED (manual edit over the basic cap).
        // The client pre-guard truncates at edit time, so this only fires for
        // edits that bypassed it — treat like skipped: never record as saved,
        // purge + toast below.
        const oversizeSet = new Set(
          (oversizeCells ?? []).map(c => `${c.rowIndex}\x00${c.columnName}`),
        )
        for (const s of group) {
          // Don't record run-locked cells as "recently saved" — they did NOT
          // persist; recording them would let a later silent reload re-overlay
          // a value the server never wrote (the run's result is the truth).
          if (locked.has(s.columnName)) {
            lockedDropped.push(s)
            lockedColNames.add(s.columnName)
            continue
          }
          // Skipped (row/column gone server-side): same — never record as
          // saved; collect for purge + resync.
          if (skippedSet.has(`${s.rowIndex}\x00${s.columnName}`)) {
            skippedDropped.push(s)
            continue
          }
          // Oversize (dropped for exceeding the basic cell cap): same handling.
          if (oversizeSet.has(`${s.rowIndex}\x00${s.columnName}`)) {
            oversizeDropped.push(s)
            continue
          }
          recentlySavedRef.current.set(
            recentlySavedKey(s.sheetId, s.rowIndex, s.columnName),
            { sheetId: s.sheetId, rowIndex: s.rowIndex, columnName: s.columnName, value: s.value, at },
          )
        }
      }).catch((err: any) => {
        const status = err?.response?.status
        // The sheet is busy with a big change. Nothing is wrong with these
        // edits: if that change was a sort, the retry after it meets the
        // generation fence below like any stale edit; otherwise it lands.
        if (status === 409 && err?.response?.data?.busy) { busy = true; throw err }
        // 409 = the fence rejected this group's EDIT-TIME generation: the
        // sheet was reordered after these edits were made, so their row
        // indices are unrecoverable. PURGE them (the toast below already
        // says "re-apply your last edit") — left queued they'd re-flush
        // with the same stale generation and 409 forever. (Before edit-time
        // stamping the retry instead picked up the reseeded generation and
        // landed on the WRONG rows — this closes that too.)
        if (status === 409) { hadConflict = true; conflictDropped.push(...group); return }
        if (isNonRetryableStatus(status)) {
          dropped.push(...group)
          // First server-provided message wins (e.g. "Column limit reached").
          dropMessage ||= err?.response?.data?.error || 'Some edits could not be saved.'
          return
        }
        throw err
      }),
    ),
  )
  if (hadConflict) {
    toast.error('This sheet was reordered in another tab. Reloaded. Re-apply your last edit.')
    reloadActiveSheet()
  }
  // Remove a set of edits from the pending queue by exact (sheet,row,col,value)
  // match so they never re-flush. The optimistic value stays visible until the
  // next reload/SSE corrects it.
  const purgeFromQueue = (toDrop: CellChange[]) => setUnsavedChanges(prev =>
    prev.filter(p => !toDrop.some(d => cellMatches(d, p))),
  )
  // 409'd groups: edit-time generation permanently stale — can never flush.
  if (conflictDropped.length > 0) purgeFromQueue(conflictDropped)
  // Deterministically-rejected edits (4xx): purge + toast why they didn't persist.
  if (dropped.length > 0) {
    purgeFromQueue(dropped)
    toast.error(dropMessage, { id: 'autosave-rejected' })
  }
  // Run-locked edits: purge so they don't re-flush every debounce for the whole
  // run, and tell the user which columns are frozen. The run's per-row result
  // fills the cell; they re-enter their value once the run finishes if needed.
  if (lockedDropped.length > 0) {
    purgeFromQueue(lockedDropped)
    const cols = Array.from(lockedColNames).join(', ')
    toast.error(
      `Edits to ${cols} weren't saved: a run is filling that column. Re-enter them after it finishes.`,
      { id: 'autosave-run-locked' },
    )
  }
  // Skipped edits (row/column deleted in another tab): purge so they don't
  // re-flush forever, and silently reload so the grid drops the orphaned
  // optimistic value and matches server truth. No loud toast — a row deleted
  // elsewhere is a normal concurrent edit, not a user-facing error; the
  // reconciling reload is enough.
  if (skippedDropped.length > 0) {
    purgeFromQueue(skippedDropped)
    reloadActiveSheet({ silent: true })
  }
  // Oversize edits dropped by the server (bypassed the pre-guard): purge so
  // they don't re-flush forever, and tell the user their edit was too long.
  if (oversizeDropped.length > 0) {
    purgeFromQueue(oversizeDropped)
    toast.error(`${oversizeDropped.length} edit${oversizeDropped.length === 1 ? '' : 's'} exceeded the ${CELL_MAX_BASIC.toLocaleString()}-character cell limit and ${oversizeDropped.length === 1 ? 'was' : 'were'} not saved.`)
    reloadActiveSheet({ silent: true })
  }
  if (busy) {
    toast('This sheet is busy with a big change. Your edits will save when it finishes.', { id: 'autosave-sheet-busy' })
    throw new RetryLaterError('Sheet busy', SHEET_BUSY_RETRY_MS)
  }
  // Only TRANSIENT failures reach here — re-throw so useAutosave retries
  // with backoff. Deterministic 4xx were already drained above.
  const failure = results.find(r => r.status === 'rejected')
  if (failure && failure.status === 'rejected') throw failure.reason
}

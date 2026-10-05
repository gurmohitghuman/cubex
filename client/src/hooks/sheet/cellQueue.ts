// Pure types + helpers for the autosave queue and the silent-reload overlay,
// extracted from useCellOps so that hook stays focused on the React wiring.
// Nothing here touches React or refs — just data shapes and predicate utilities.

export interface CellChange {
  // The sheet this edit was made on. Stamped at enqueue time so a flush ALWAYS
  // targets the originating sheet — never `activeSheet` as it is at flush time.
  // Without this, switching sheets (or an unmount-surviving backoff timer)
  // during the debounce/retry window writes one sheet's edits into another.
  sheetId: string
  rowIndex: number
  columnName: string
  value: string
  // row_generation the tab held when the edit was MADE (undefined if unseeded).
  // Flushes send THIS, never the generation at flush time: a reload that
  // commits a new generation between edit and flush must not bless a stale
  // (rowIndex-addressed) edit — the server fence 409s it and the conflict
  // recovery drops it, instead of it landing on the wrong post-sort row.
  generation?: number
}

// An acked-but-not-yet-loud-reloaded edit, held for the silent-reload overlay.
// `at` (save timestamp) bounds its lifetime so a later run that legitimately
// changes the same cell isn't masked forever by the user's older value.
export interface SavedCell {
  sheetId: string
  rowIndex: number
  columnName: string
  value: string
  at: number
}

// Stable key for the recently-saved overlay map. NUL-delimited so a column name
// containing the delimiter can't collide with a different (row, column) pair.
export const recentlySavedKey = (sheetId: string, rowIndex: number, columnName: string) =>
  `${sheetId}\x00${rowIndex}\x00${columnName}`

// Classify an autosave PUT failure. A 4xx (other than the exceptions below) is
// DETERMINISTIC: the same payload will fail identically every time — over-limit
// (column/row cap, 400), a rejected value, 403/404. Retrying it is pointless
// and, worse, the failed items stay queued and re-flush on every later edit,
// permanently poisoning the whole save queue (the user can't save anything on
// this sheet). So we treat those as terminal: drop the items + show the
// server's message. 5xx / network / timeout are TRANSIENT — keep them queued
// and let useAutosave back off and retry.
//
// Exceptions that must NOT be dropped:
//   409 — stale index, handled separately (reload + re-apply).
//   401 — session expired. NOT deterministic: the SAME payload succeeds once
//         the user re-authenticates. Dropping it here loses the edit, because
//         the 401 interceptor (client.ts) redirects to /login and the stash
//         mirror would persist an already-purged queue → nothing to restore
//         after login. Keep it queued + stashed so re-hydration recovers it.
//   408 — request timeout; same transient reasoning as a network timeout.
//   429 — rate limited. TRANSIENT by definition: the SAME payload succeeds once
//         the window frees. Dropping it silently loses the edit — the exact
//         data-loss class the run modals' 1Hz polling made reachable in normal
//         use. Keep it queued so useAutosave backs off and retries.
export const isNonRetryableStatus = (status: number | undefined): boolean =>
  typeof status === 'number' && status >= 400 && status < 500 &&
  status !== 409 && status !== 401 && status !== 408 && status !== 429

// Delete every overlay entry matching `pred`. Snapshots the entries first so the
// in-loop delete is safe. Shared by all the drop-pending reconciliation paths.
export function pruneRecentlySaved(
  map: Map<string, SavedCell>,
  pred: (e: SavedCell) => boolean,
): void {
  for (const [key, e] of Array.from(map.entries())) {
    if (pred(e)) map.delete(key)
  }
}

// Exact (sheet,row,col,value,generation) equality — used to purge specific edits
// the server dropped (409'd fence, deterministic 4xx, run-locked columns) from
// the pending queue. Generation is part of identity: a 409'd old-generation edit
// must not purge a NEWER same-value edit the user made at the same coordinates
// after a reload (that one is still valid and must flush).
export const cellMatches = (a: CellChange, b: CellChange): boolean =>
  a.sheetId === b.sheetId && a.rowIndex === b.rowIndex &&
  a.columnName === b.columnName && a.value === b.value &&
  a.generation === b.generation

import { api } from './client'
import { DEDUPE_REQUEST_TIMEOUT_MS } from '../../lib/constants'
import type { DedupeKeep, DedupeMatch } from '../../lib/dedupe'

// Removing duplicate rows (server routes/sheets-dedupe.ts, services/dedupe-*.ts).

export interface DedupeColumn { column: string; match: DedupeMatch; phone_country?: string }
export interface DedupeBody { columns: DedupeColumn[]; keep: DedupeKeep }

// row: the row number the grid shows; values: the matched columns' cells as written.
export interface DedupeSampleRow { id: string; row: number; values: Record<string, string> }
export interface DedupeSampleGroup { kept: DedupeSampleRow; removed: DedupeSampleRow[]; size: number }

export interface DedupeReport {
  rowsChecked: number
  // The rows that go (or went).
  duplicateRows: number
  groups: number
  // Rows missing a value in any matched column (empty, unreadable, a run's status): never removed.
  emptyKeyRows: number
  samples: DedupeSampleGroup[]
  // The biggest group when it isn't a sample already ("n/a" in 4,000 rows shows here).
  largest: DedupeSampleGroup | null
}

export interface DedupeBlockingRun { id: string; kind: 'ai' | 'http'; column: string | null; paused: boolean }
export interface DedupeCheckResult extends DedupeReport {
  // A run holding the sheet: removing is refused until it ends.
  blockedBy: { message: string; run: DedupeBlockingRun } | null
}
// trashId: the trash batch holding the removed rows (null: none removed, or Settings keeps nothing).
export interface DedupeRemoveResult extends DedupeReport { removed: number; rowsLeft: number; trashId: number | null }

// Each caller shows the server's error in place, so the generic server-error toast stays off.
const options = { skipServerErrorToast: true, timeout: DEDUPE_REQUEST_TIMEOUT_MS } as const

export const dedupeAPI = {
  // A pure read: what removing would do. A newer check (or closing the dialog) aborts it.
  check: (sheetId: string, body: DedupeBody, signal?: AbortSignal): Promise<DedupeCheckResult> =>
    api.post(`/sheets/${sheetId}/duplicates/check`, body, { ...options, signal }).then(res => res.data),

  // Removes them for good, working the plan out again on the rows as they are now.
  remove: (sheetId: string, body: DedupeBody): Promise<DedupeRemoveResult> =>
    api.post(`/sheets/${sheetId}/duplicates/remove`, body, options).then(res => res.data),
}

// Auto-dedupe (server routes/sheets-auto-dedupe.ts, services/auto-dedupe-*.ts):
// one key column; a row that arrives (or gets a key typed in) whose key
// another row has keeps the oldest or the newest of them, the rest go to the trash.
export type AutoDedupeKeep = 'oldest' | 'newest'
export interface AutoDedupeView {
  column: string
  match: DedupeMatch
  phone_country: string | null
  keep: AutoDedupeKeep
  // building: the sheet's keys are being read; rows arriving meanwhile are checked once they are.
  state: 'building' | 'on'
  // Rows whose check waits (a run is working on a row that would go, or the keys are catching up).
  waiting_rows: number
  // Rows that already shared a key with an older row when it was turned on (left as they were).
  shared_rows: number | null
  removed_rows: number
  since: string
}
export interface AutoDedupeBody { column: string; match: DedupeMatch; phone_country?: string; keep: AutoDedupeKeep }

// What the grid's autosave hears when an edited key matched another row's (PUT /:id/data).
export interface GridAutoDedupe {
  column: string; keep: AutoDedupeKeep; removed: number[]; trashId: number | null; seqs: number[]; waiting: number
}

// What a CSV import says about the rows auto-dedupe didn't keep.
// removed: every row that went (the file's own and older rows they replaced); notKept: the file's own.
export interface ImportAutoDedupe {
  column: string; keep: AutoDedupeKeep; removed: number; notKept: number; trashId: number | null; left: boolean
}

const quiet = { skipServerErrorToast: true } as const

export const autoDedupeAPI = {
  get: (sheetId: string): Promise<AutoDedupeView | null> =>
    api.get(`/sheets/${sheetId}/auto-dedupe`, quiet).then(res => res.data.autoDedupe),
  set: (sheetId: string, body: AutoDedupeBody): Promise<AutoDedupeView> =>
    api.put(`/sheets/${sheetId}/auto-dedupe`, body, quiet).then(res => res.data.autoDedupe),
  off: (sheetId: string): Promise<null> =>
    api.delete(`/sheets/${sheetId}/auto-dedupe`, quiet).then(() => null),
}

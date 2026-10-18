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

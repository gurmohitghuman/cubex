import { api } from './client'
import type { PhoneFormat } from '../../lib/cleaners'

// Clean data columns (server routes/sheets-clean.ts, services/clean-*.ts): a
// column filled for free from a source column by a cleaner (lib/cleaners.ts).

export interface CleanOptions { phoneFormat?: PhoneFormat; phoneCountry?: string }

// A clean column's setup and its last fill, from the sheet payload (cleanColumns).
export interface CleanColumnView {
  column: string
  source: string
  cleaner: string
  options: CleanOptions
  autoRun: boolean
  status: 'filling' | 'done' | 'failed'
  // The last fill: cells it left holding a value, and source values it couldn't read (left blank).
  cleanedRows: number
  blankRows: number
  error: string | null
}

// column: the clean column (the server's default name when left out). Naming
// an existing clean column changes its setup and cleans every row again.
// autoRun: left out keeps an existing column's auto-run (a new one starts on).
export interface CleanColumnBody {
  source: string
  cleaner: string
  column?: string
  options?: CleanOptions
  autoRun?: boolean
}

export interface CleanPreviewResult {
  column: string
  // It is a clean column already: cleaning it again replaces its setup.
  existing: boolean
  samples: Array<{ row: number; before: string; after: string }>
}

// 'filling': the server answered before the fill was done; the column shows ⏳
// until the fill's end reloads the tab.
export interface CleanStartResult { column: string; created: boolean; status: 'filling' | 'done' | 'failed' }

// Each caller shows the server's error in place, so the generic server-error toast stays off.
const noServerToast = { skipServerErrorToast: true } as const

export const cleanAPI = {
  // A pure read (allowed while the sheet is busy): the first rows, before and after.
  preview: (sheetId: string, body: CleanColumnBody, signal?: AbortSignal): Promise<CleanPreviewResult> =>
    api.post(`/sheets/${sheetId}/clean-columns/preview`, body, { ...noServerToast, signal }).then(res => res.data),

  // Creates the clean column (or changes one, or cleans it again). Answers
  // once the fill is done or after a few seconds.
  start: (sheetId: string, body: CleanColumnBody): Promise<CleanStartResult> =>
    api.post(`/sheets/${sheetId}/clean-columns`, body, noServerToast).then(res => res.data),
}

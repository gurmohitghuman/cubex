import { api } from './client'

// Lookup columns (server routes/sheets-lookup.ts, services/lookup-*.ts): a
// column filled for free from another sheet, by matching a column of this row
// against a column there.

export type LookupMatch = 'equals' | 'contains'
export type LookupReturns = 'value' | 'exists' | 'count' | 'list'

// A lookup column's setup and its last fill, from the sheet payload (lookupColumns).
export interface LookupColumnView {
  column: string
  sourceColumn: string
  otherSheetId: string
  // The other sheet's name and table now (null: it was deleted).
  otherSheet: string | null
  otherTable: string | null
  matchColumn: string
  match: LookupMatch
  returns: LookupReturns
  // 'value': [the column]; 'list': the columns each match carries, null = all of them.
  returnColumns: string[] | null
  limit: number
  autoRun: boolean
  autoRunNote: string | null
  status: 'filling' | 'done' | 'failed'
  // What a fill waits for ("Waiting for "Companies" to finish sorting.").
  waiting: string | null
  filledRows: number
  errorRows: number
  firstError: string | null
  error: string | null
  // Why it can't look up any more (the other sheet, or a column it reads, was deleted).
  broken: string | null
}

// A sheet it can look in, with its columns (any table but this sheet).
export interface LookupTarget {
  sheetId: string; sheetName: string; tableId: string; tableName: string; columns: string[]
}

// column: the lookup column. Naming an existing lookup column changes it and
// looks every row up again. autoRun: left out keeps an existing column's
// auto-run (a new one starts on).
export interface LookupColumnBody {
  column?: string
  sourceColumn: string
  otherSheetId: string
  matchColumn: string
  match: LookupMatch
  returns: LookupReturns
  returnColumn?: string
  returnColumns?: string[]
  limit?: number
  autoRun?: boolean
}

export interface LookupPreviewSample { row: number; value: string; result: string; error: string | null }

export interface LookupPreviewResult {
  column: string | null
  // A lookup column already: saving looks every row up again.
  existing: boolean
  otherSheet: string
  otherRows: number
  // Rows of the other sheet the preview read (null: every row, through its index).
  checkedRows: number | null
  samples: LookupPreviewSample[]
}

export interface LookupStartResult { column: string; created: boolean; status: 'filling' | 'done' | 'failed' }

const quiet = { skipServerErrorToast: true } as const

export const lookupAPI = {
  targets: (sheetId: string): Promise<LookupTarget[]> =>
    api.get(`/sheets/${sheetId}/lookup-columns/targets`, quiet).then(res => res.data.sheets),

  // A pure read (allowed while the sheet is busy): what the lookup gives on the first rows.
  preview: (sheetId: string, body: LookupColumnBody, signal?: AbortSignal): Promise<LookupPreviewResult> =>
    api.post(`/sheets/${sheetId}/lookup-columns/preview`, body, { ...quiet, signal }).then(res => res.data),

  // Creates the lookup column (or changes one). Answers once the fill is done or after a few seconds.
  start: (sheetId: string, body: LookupColumnBody): Promise<LookupStartResult> =>
    api.post(`/sheets/${sheetId}/lookup-columns`, body, quiet).then(res => res.data),
}

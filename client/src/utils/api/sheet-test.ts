import { api } from './client'
import type { PlannedColumn, SetupVersion } from './setup-versions'

// Trying column changes on sample rows (server routes/sheets-test.ts, services/sheet-test-*.ts): a hidden copy of a
// sheet with some of its rows and its setup, changed and run there, then applied to the sheet or discarded. The
// sheet itself takes no changes meanwhile. Field names match /api/v1/sheets/:id/test and MCP's manage_sheet.
export interface SheetTestView {
  test_id: string
  sheet_id: string          // the sheet tested
  test_sheet_id: string     // its copy
  table_id: string
  sheet_name: string
  rows: number
  started_at: string
  state: 'open' | 'ending'
}

export interface ApplyTestAnswer {
  test: SheetTestView
  dry_run: boolean
  nothing: boolean
  blocked: string | null
  columns: PlannedColumn[]
  results_kept: Record<string, number>
  worked_out_again: string[]
  not_in_test: string[]
  saved_before: SetupVersion | null
  message: string
}

const quiet = { skipServerErrorToast: true }

export const sheetTestAPI = {
  // The rows selected in the grid (by place), or the top ones (10).
  start: (sheetId: string, rowIndexes?: number[]): Promise<SheetTestView> =>
    api.post(`/sheets/${sheetId}/test`, rowIndexes?.length ? { row_indexes: rowIndexes } : {}, quiet)
      .then(res => res.data.test),
  addRows: (sheetId: string, how: 'top' | 'random'): Promise<{ test: SheetTestView; added: number }> =>
    api.post(`/sheets/${sheetId}/test/rows`, { how }, quiet).then(res => res.data),
  apply: (sheetId: string, dryRun: boolean): Promise<ApplyTestAnswer> =>
    api.post(`/sheets/${sheetId}/test/apply`, { dry_run: dryRun }, quiet).then(res => res.data),
  discard: (sheetId: string): Promise<SheetTestView> =>
    api.post(`/sheets/${sheetId}/test/discard`, {}, quiet).then(res => res.data.test),
}

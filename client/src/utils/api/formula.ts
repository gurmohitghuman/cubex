import { api } from './client'

// Formula columns (server routes/sheets-formula.ts, services/formula-*.ts): a
// column worked out for free from each row by a JavaScript formula reading
// cells as {{Column}}, run in the server's sandbox (never in the browser).

// A formula column's setup and its last fill, from the sheet payload (formulaColumns).
export interface FormulaColumnView {
  column: string
  formula: string
  inputs: string[]
  description: string | null
  autoRun: boolean
  // Why its auto-run is paused (a formula too slow), when it is.
  autoRunNote: string | null
  status: 'filling' | 'done' | 'failed'
  filledRows: number
  // Rows showing "❌ <the error>", and the first of them ("Row N: …").
  errorRows: number
  firstError: string | null
  // Why the fill stopped.
  error: string | null
}

// column: the formula column. Naming an existing formula column changes its
// formula and works every row out again. autoRun: left out keeps an existing
// column's auto-run (a new one starts on).
export interface FormulaColumnBody {
  formula: string
  column?: string
  description?: string
  autoRun?: boolean
}

export interface FormulaPreviewSample {
  row: number
  inputs: Record<string, string>
  result: string
  error: string | null
}

export interface FormulaPreviewResult {
  column: string | null
  // It is a formula column already: saving works every row out again.
  existing: boolean
  // As it will be saved: every {{reference}} naming its column exactly.
  formula: string
  reads: string[]
  samples: FormulaPreviewSample[]
  // The formula ran out of time or memory on the sample rows.
  stopped: string | null
}

export interface WrittenFormula {
  model: string
  model_source: 'picked' | 'sheet' | 'account'
  cost_usd: number | null
  formula: string
  preview: FormulaPreviewResult
}

// 'filling': the server answered before the fill was done; the column shows ⏳
// until the fill's end reloads the tab.
export interface FormulaStartResult { column: string; created: boolean; status: 'filling' | 'done' | 'failed' }

// Each caller shows the server's error in place, so the generic server-error toast stays off.
const quiet = { skipServerErrorToast: true } as const

export const formulaAPI = {
  // A pure read (allowed while the sheet is busy): what the formula gives on the first rows.
  preview: (sheetId: string, body: FormulaColumnBody, signal?: AbortSignal): Promise<FormulaPreviewResult> =>
    api.post(`/sheets/${sheetId}/formula-columns/preview`, body, { ...quiet, signal }).then(res => res.data),

  // One small call to the sheet's AI model; nothing is saved.
  write: (sheetId: string, words: string): Promise<WrittenFormula> =>
    api.post(`/sheets/${sheetId}/formula-columns/write`, { words }, quiet).then(res => res.data),

  // Creates the formula column (or changes one). Answers once the fill is done or after a few seconds.
  start: (sheetId: string, body: FormulaColumnBody): Promise<FormulaStartResult> =>
    api.post(`/sheets/${sheetId}/formula-columns`, body, quiet).then(res => res.data),
}

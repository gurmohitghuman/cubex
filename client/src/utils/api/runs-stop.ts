import { api } from './client'

// Stopping every run on a sheet at once (server routes/sheets-runs-stop.ts,
// services/sheet-runs-stop.ts). The same answer /api/v1 and MCP give.
export interface StoppedRun {
  run_type: 'ai' | 'http' | 'enrichment'; run_id: string; column: string; auto_run: boolean
}
export interface SheetStopResult {
  stopped_runs: StoppedRun[]
  stopped_setup_runs: Array<{ setup_run_id: string; setup: string }>
  // Auto-run columns whose batch it stopped: paused until resumed.
  auto_run_paused: string[]
  // Auto-run columns still on: new rows start runs there again.
  auto_run_on: string[]
  // Free fills (clean, formula, stored answers) that finish on their own.
  still_filling: string[]
  // What it did, in a sentence or few, for the toast.
  message: string
}

export const runsStopAPI = {
  stopAll: (sheetId: string): Promise<SheetStopResult> =>
    api.post(`/sheets/${sheetId}/runs/stop`, null, { skipServerErrorToast: true }).then(res => res.data),
}

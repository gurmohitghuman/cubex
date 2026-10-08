import { api } from './client'
import type { EnrichDailyLimit as DailyLimitView } from './types-settings'
import type { AutorunRowsEstimate, AutorunSave, AutorunTargetInfo, SheetAutorun } from './types-autorun'

export interface AutorunEstimate { autoRuns: AutorunRowsEstimate[]; dailyLimit: DailyLimitView }

// Each caller shows its own error in place, so the generic server-error toast stays off.
const noServerToast = { skipServerErrorToast: true } as const

export const autorunAPI = {
  // With a column, also what the dialog needs about it (`target`).
  get: (sheetId: string, column?: string):
    Promise<SheetAutorun & { dailyLimit: DailyLimitView; target?: AutorunTargetInfo }> =>
    api.get(`/autorun/sheets/${sheetId}`, { ...noServerToast, params: column ? { column } : {} })
      .then(res => res.data),

  // Turns a column's auto-run on (with its "Only run if" and daily cap) or off.
  save: (sheetId: string, body: AutorunSave): Promise<SheetAutorun> =>
    api.put(`/autorun/sheets/${sheetId}/columns`, body, noServerToast).then(res => res.data),

  // Pauses or resumes one column's auto-run, or every auto-run on the sheet.
  pause: (sheetId: string, paused: boolean, column?: string): Promise<SheetAutorun> =>
    api.post(`/autorun/sheets/${sheetId}/pause`, { paused, ...(column ? { column } : {}) }, noServerToast)
      .then(res => res.data),

  // What `rows` new rows (a CSV import) would set off. A pure read.
  estimate: (sheetId: string, rows: number): Promise<AutorunEstimate> =>
    api.post(`/autorun/sheets/${sheetId}/estimate`, { rows }, noServerToast).then(res => res.data),
}

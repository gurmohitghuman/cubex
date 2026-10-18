// Undoing a run: the column menu's "Undo last run" for AI, HTTP API,
// enrichment and waterfall columns. Mirrors server/src/routes/run-undo.ts and
// services/run-undo*.ts (UndoView).
import { api } from './client'

const noServerToast = { skipServerErrorToast: true } as const

export type UndoRunType = 'ai' | 'http'

export interface UndoView {
  run_id: string; run_type: UndoRunType; sheet_id: string; column: string | null
  // none: the run kept nothing to undo.
  state: 'kept' | 'undoing' | 'undone' | 'dropping' | 'none'
  rows: number; restored: number; skipped: number; gone: number
  started_at: string; undone_at: string | null; kept_until: string | null
  can_undo: boolean; reason: string | null
}

export const runUndoAPI = {
  // The column's newest run that can still be undone (null: none).
  last: (sheetId: string, column: string): Promise<UndoView | null> =>
    api.get(`/run-undo/sheets/${sheetId}/last`, { params: { column }, ...noServerToast }).then(r => r.data.undo),

  read: (sheetId: string, runType: UndoRunType, runId: string): Promise<UndoView> =>
    api.get(`/run-undo/sheets/${sheetId}/runs/${runType}/${runId}`, noServerToast).then(r => r.data.undo),

  undo: (sheetId: string, runType: UndoRunType, runId: string): Promise<UndoView> =>
    api.post(`/run-undo/sheets/${sheetId}/undo`, { runType, runId }, noServerToast).then(r => r.data.undo),
}

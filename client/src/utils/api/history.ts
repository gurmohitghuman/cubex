import { api } from './client'

// A sheet's change log (server routes/sheets-history.ts, services/sheet-history.ts):
// setup changes and big row changes, newest first, with who made them. Field
// names match /api/v1/sheets/:id/history and MCP get_sheet_history.
export interface SheetChange {
  id: number
  at: string
  via: 'app' | 'api' | 'mcp' | 'cubex'
  token_name: string | null
  by: string
  action: string
  column: string | null
  summary: string
  detail: Record<string, unknown> | null
  in_trash?: boolean
}

export interface SheetHistory { changes: SheetChange[]; next_before: number | null; kept_days: number }

export const historyAPI = {
  read: (sheetId: string, ask: { before?: number; column?: string } = {}, signal?: AbortSignal):
    Promise<SheetHistory> =>
    api.get(`/sheets/${sheetId}/history`, { params: ask, signal, skipServerErrorToast: true })
      .then(res => res.data),
}

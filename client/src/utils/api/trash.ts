import { api } from './client'

// The trash (server routes/trash.ts, services/trash-*.ts): deleted tables,
// sheets and batches of rows, kept for the days Settings sets, restored or
// deleted for good. Field names match /api/v1/trash and MCP list_trash.
export type TrashKind = 'rows' | 'sheet' | 'table'
export type TrashHow = 'grid' | 'api' | 'duplicates' | 'auto_dedupe' | 'import' | 'transfer' | 'sheet' | 'table'

export interface TrashEntry {
  id: number
  kind: TrashKind
  state: 'moving' | 'kept' | 'restoring' | 'purging'
  deleted_at: string
  expires_at: string
  table_id: string
  table_name: string
  sheet_id: string | null
  sheet_name: string | null
  how: TrashHow
  by: string
  via: 'app' | 'api' | 'mcp' | 'cubex'
  token_name: string | null
  rows: number
  bytes: number
  columns: string[]
  restored_so_far?: number
  blocked?: string
  note?: string
}

export interface TrashList { items: TrashEntry[]; kept_days: number; next_before: number | null; total_bytes: number }

export interface TrashRow { seq: number; row_id: string; old_row_index: number; cells: Record<string, string> }
export interface TrashRowsPage { trash_id: number; columns: string[]; rows: TrashRow[]; next_after: number | null }

export interface TrashRestoreResult {
  trash_id: number
  restored?: {
    kind?: 'sheet' | 'table'; state: 'restored' | 'restoring'; rows?: number; place?: 'old' | 'end'
    name?: string; renamed?: boolean; sheet_id?: string | null; table_id?: string
    columns_added?: string[]; columns_left_out?: string[]
  }
  error?: string
  busy?: boolean
}

export interface TrashListAsk { q?: string; kind?: TrashKind; how?: TrashHow; sheet_id?: string; before?: number }
export interface TrashRowsAsk { after?: number; limit?: number; column?: string; contains?: string }

const quiet = { skipServerErrorToast: true } as const

export const trashAPI = {
  list: (ask: TrashListAsk = {}, signal?: AbortSignal): Promise<TrashList> =>
    api.get('/trash', { params: ask, signal, ...quiet }).then(res => res.data),
  rows: (id: number, ask: TrashRowsAsk = {}, signal?: AbortSignal): Promise<TrashRowsPage> =>
    api.get(`/trash/${id}/rows`, { params: ask, signal, ...quiet }).then(res => res.data),
  restore: (ids: number[]): Promise<{ results: TrashRestoreResult[] }> =>
    api.post('/trash/restore', { ids }, quiet).then(res => res.data),
  restoreRows: (id: number, seqs: number[]): Promise<NonNullable<TrashRestoreResult['restored']>> =>
    api.post(`/trash/${id}/restore-rows`, { seqs }, quiet).then(res => res.data),
  deleteForGood: (ids: number[]): Promise<{ deleting: number[] }> =>
    api.post('/trash/delete', { ids }, quiet).then(res => res.data),
  csv: (id: number): Promise<Blob> =>
    api.get(`/trash/${id}/csv`, { responseType: 'blob', ...quiet }).then(res => res.data),
  getDays: (): Promise<{ days: number; maxDays: number }> => api.get('/settings/trash').then(res => res.data),
  setDays: (days: number): Promise<{ days: number; maxDays: number }> =>
    api.put('/settings/trash', { days }).then(res => res.data),
}

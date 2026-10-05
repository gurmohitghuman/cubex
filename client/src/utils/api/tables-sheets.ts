import { api } from './client'
import type { Sheet, SheetData, Table } from './types'

// Opt these requests out of the interceptor's generic "Server error occurred" toast.
// Every caller surfaces its own signal on failure: structural ops (add/delete/rename/
// import/sort) have a specific catch toast, and the autosave write path (updateData /
// bulkDeleteRows) shows a persistent "Save failed · Retry" pill (SaveStatus). Without
// this, a 5xx stacks a redundant second toast on top — and on autosave's backoff it
// fired once per retry. See client.ts for the flag.
const noServerToast = { skipServerErrorToast: true } as const

export const tablesAPI = {
  getAll: (): Promise<Table[]> => api.get('/tables', noServerToast).then(res => res.data),
  getById: (id: string): Promise<Table> => api.get(`/tables/${id}`, noServerToast).then(res => res.data),
  create: (name: string): Promise<Table> => api.post('/tables', { name }, noServerToast).then(res => res.data),
  update: (id: string, name: string): Promise<Table> => api.put(`/tables/${id}`, { name }, noServerToast).then(res => res.data),
  delete: (id: string): Promise<void> => api.delete(`/tables/${id}`, noServerToast).then(() => {}),
}

export const sheetsAPI = {
  getData: (id: string, limit?: number, offset?: number): Promise<SheetData> =>
    api.get(`/sheets/${id}`, { params: { limit, offset }, ...noServerToast }).then(res => res.data),

  updateData: (
    id: string,
    updates: Array<{ rowIndex: number; columnName: string; value: string }>,
    // The row_generation the client last loaded for this sheet. The server 409s
    // if it has since changed (sort / replace-import) so we don't write to stale
    // row indices. Omitted ⇒ server skips the fence (backwards compatible).
    rowGeneration?: number,
    // 'update' = UPDATE-ONLY (never create a row/column) — defense in depth for
    // grid cell edits, so a stale/queue-bypassing save can't resurrect deleted
    // structure. Default 'upsert' (server default) keeps the AI/HTTP preview-commit
    // paths able to create columns. Returns what the server skipped: `skipped`
    // (count of stale row/column misses), `skippedCells` (their identities, so the
    // client can purge them from the queue + resync rather than treating a skipped
    // no-op as saved) and `lockedColumns` (names of columns an active run owns,
    // whose edits were dropped — see getLockedRunColumns server-side).
    mode?: 'upsert' | 'update',
  ): Promise<{ skipped: number; skippedCells: Array<{ rowIndex: number; columnName: string }>; lockedColumns: string[]; oversizeCells: Array<{ rowIndex: number; columnName: string }> }> =>
    api.put(`/sheets/${id}/data`, { updates, rowGeneration, mode }, noServerToast)
      .then(r => ({
        skipped: (r.data as { skipped?: number })?.skipped ?? 0,
        skippedCells: (r.data as { skippedCells?: Array<{ rowIndex: number; columnName: string }> })?.skippedCells ?? [],
        lockedColumns: (r.data as { lockedColumns?: string[] })?.lockedColumns ?? [],
        // Cells dropped for exceeding the basic-cell size cap (P2-8).
        oversizeCells: (r.data as { oversizeCells?: Array<{ rowIndex: number; columnName: string }> })?.oversizeCells ?? [],
      })),

  importCSV: (id: string, file: File, replaceData: boolean = false): Promise<{ rowsImported: number; startingRow: number; newColumns: string[] }> => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('replaceData', replaceData.toString())
    return api.post(`/sheets/${id}/import`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      // Default 30s axios timeout cuts off large imports. A 50k-row × 80-col CSV
      // requires ~4M cell INSERTs which takes 30-60s on a typical machine even with
      // WAL+NORMAL. Allow up to 10 minutes for the response.
      timeout: 600000,
      ...noServerToast,
    }).then(res => res.data)
  },

  exportCSV: (id: string): Promise<Blob> =>
    api.get(`/sheets/${id}/export`, { responseType: 'blob', ...noServerToast }).then(res => res.data),

  getColumns: (id: string): Promise<Array<{ name: string; reference: string }>> =>
    api.get(`/sheets/${id}/columns`, noServerToast).then(res => res.data),

  // rowGeneration is REQUIRED: the server hard-400s a bulk-delete without it
  // (it's a destructive structural mutation — see sheets-rows-mutate.ts). Callers
  // pass the generation the sheet was loaded at; the server 409s on mismatch.
  bulkDeleteRows: (sheetId: string, rowIndices: number[], rowGeneration: number): Promise<{ deletedCount: number }> =>
    api.post(`/sheets/${sheetId}/rows/bulk-delete`, { rowIndices, rowGeneration }, noServerToast).then(res => res.data),

  deleteColumn: (sheetId: string, columnName: string): Promise<void> =>
    api.delete(`/sheets/${sheetId}/columns/${encodeURIComponent(columnName)}`, noServerToast).then(() => {}),

  renameColumn: (sheetId: string, oldName: string, newName: string): Promise<void> =>
    api.put(`/sheets/${sheetId}/columns/${encodeURIComponent(oldName)}`, { newName }, noServerToast).then(() => {}),

  // Resolves to the name as stored: the server trims it and strips characters
  // a name can't hold (invisible ones, " and \).
  addColumn: (sheetId: string, columnName: string): Promise<string> =>
    api.post(`/sheets/${sheetId}/columns`, { columnName }, noServerToast)
      .then(res => (typeof res.data?.columnName === 'string' ? res.data.columnName : columnName)),

  addRows: (sheetId: string, count: number): Promise<{ rowIndexes: number[] }> =>
    api.post(`/sheets/${sheetId}/rows`, { count }, noServerToast).then(res => res.data),

  reorderColumns: (sheetId: string, columnOrder: string[]): Promise<void> =>
    api.put(`/sheets/${sheetId}/columns/reorder`, { columnOrder }, noServerToast).then(() => {}),

  // One-time physical sort (Google Sheets semantics): the server rewrites
  // row_index so the sorted order becomes THE row order. No persistent sort
  // view exists anymore — reload the sheet after this resolves.
  sortSheet: (sheetId: string, column: string, direction: 'asc' | 'desc'): Promise<{ rowsReordered: number }> =>
    api.post(`/sheets/${sheetId}/sort`, { column, direction }, noServerToast).then(res => res.data),

  updateEmptyFilter: (
    sheetId: string,
    emptyFilter: Record<string, 'empty' | 'not_empty'> | null,
  ): Promise<void> => api.put(`/sheets/${sheetId}/empty-filter`, { emptyFilter }, noServerToast).then(() => {}),

  // Per-column "text contains" filter. null clears all; value keyed by column name.
  updateColumnFilters: (
    sheetId: string,
    columnFilters: Record<string, { type: 'contains'; value: string }> | null,
  ): Promise<void> => api.put(`/sheets/${sheetId}/column-filters`, { columnFilters }, noServerToast).then(() => {}),

  updateDefaultModel: (sheetId: string, model: string | null): Promise<void> =>
    api.put(`/sheets/${sheetId}/default-model`, { model }, noServerToast).then(() => {}),

  updateDefaultConcurrency: (sheetId: string, concurrency: number | null): Promise<void> =>
    api.put(`/sheets/${sheetId}/default-concurrency`, { concurrency }, noServerToast).then(() => {}),

  // Sheet (tab) CRUD — mounted server-side under /api/tables/:tableId/sheets. All return
  // the authoritative { sheets } list so the caller reconciles (multi-tab/device drift).
  // noServerToast: each caller (useSheetOps) shows its own success/error toast.
  createSheet: (tableId: string, body: { name?: string; afterSheetId?: string }): Promise<{ sheet: Sheet; sheets: Sheet[] }> =>
    api.post(`/tables/${tableId}/sheets`, body, noServerToast).then(r => r.data),

  renameSheet: (tableId: string, sheetId: string, name: string): Promise<{ sheet: Sheet; sheets: Sheet[] }> =>
    api.patch(`/tables/${tableId}/sheets/${sheetId}`, { name }, noServerToast).then(r => r.data),

  reorderSheets: (tableId: string, orderedSheetIds: string[]): Promise<{ sheets: Sheet[] }> =>
    api.patch(`/tables/${tableId}/sheets/reorder`, { orderedSheetIds }, noServerToast).then(r => r.data),

  deleteSheet: (tableId: string, sheetId: string): Promise<{ sheets: Sheet[] }> =>
    api.delete(`/tables/${tableId}/sheets/${sheetId}`, noServerToast).then(r => r.data),
}

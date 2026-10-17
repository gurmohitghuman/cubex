import { api } from './client'
import type { ColumnFilter } from '@/lib/filters'

// Saved views of a sheet (server routes/sheets-views.ts, services/views.ts):
// a name, a description, filters and hidden columns. Never a sort, never a
// column order. The active one's filters are the sheet's (empty_filter,
// column_filters, row_filter).
export interface WhereCondition extends Omit<ColumnFilter, 'type'> { column?: string; operator: ColumnFilter['type'] }
export type WhereItem = WhereCondition | { or: WhereCondition[] }

export interface SheetView {
  id: string
  name: string
  description: string | null
  is_default: boolean
  active: boolean
  hidden_columns: string[]
  where: WhereItem[]
}

export type ViewStarter = 'errors' | 'filled'

const quiet = { skipServerErrorToast: true } as const
const view = (r: { data: { view: SheetView } }) => r.data.view

export const viewsAPI = {
  // A copy of the active view, switched to.
  create: (sheetId: string, name: string, description: string): Promise<SheetView> =>
    api.post(`/sheets/${sheetId}/views`, { name, description }, quiet).then(view),
  starter: (sheetId: string, kind: ViewStarter): Promise<SheetView> =>
    api.post(`/sheets/${sheetId}/views/starter`, { kind }, quiet).then(view),
  update: (
    sheetId: string, viewId: string, changes: { name?: string; description?: string; hiddenColumns?: string[] },
  ): Promise<SheetView> => api.patch(`/sheets/${sheetId}/views/${viewId}`, changes, quiet).then(view),
  remove: (sheetId: string, viewId: string): Promise<void> =>
    api.delete(`/sheets/${sheetId}/views/${viewId}`, quiet).then(() => {}),
  activate: (sheetId: string, viewId: string): Promise<SheetView> =>
    api.post(`/sheets/${sheetId}/views/${viewId}/activate`, null, quiet).then(view),
  // viewId: the view it was cleared in (409 viewChanged once another one shows).
  clearRowFilter: (sheetId: string, viewId: string | null): Promise<void> =>
    api.put(`/sheets/${sheetId}/row-filter`, { rowFilter: null, viewId }, quiet).then(() => {}),
}

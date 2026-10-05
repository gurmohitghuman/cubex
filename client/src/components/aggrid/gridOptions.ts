import type { ColDef, GetRowIdParams, RowSelectionOptions } from 'ag-grid-community'

// Grid options that never change, defined ONCE at module level. ag-grid-react
// diffs its props by reference on every render, so an inline object or arrow
// function reads as "changed" each time — and a "changed" defaultColDef makes
// AG Grid rebuild every column (recreateColumnDefs) on every re-render of the
// sheet: each cell edit, live-update batch and loadMore page.

export const DEFAULT_COL_DEF: ColDef = {
  sortable: false, filter: true, resizable: true, editable: true, minWidth: 100, suppressSizeToFit: true,
}

export const ROW_SELECTION: RowSelectionOptions = { mode: 'multiRow', enableSelectionWithoutKeys: true }

export const getRowId = (params: GetRowIdParams): string => params.data.__rowIndex.toString()

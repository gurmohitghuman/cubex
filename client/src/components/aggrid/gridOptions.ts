import type {
  CellClassParams, ColDef, GetRowIdParams, RowSelectionOptions, SuppressKeyboardEventParams,
} from 'ag-grid-community'

// The keys that open search: "/" alone, or Cmd/Ctrl+F (the browser's own find
// sees only the rows the tab holds).
export const isSearchKey = (e: KeyboardEvent): boolean =>
  (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey)
  || ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey)

// Grid options that never change, defined ONCE at module level. ag-grid-react
// diffs its props by reference on every render, so an inline object or arrow
// function reads as "changed" each time — and a "changed" defaultColDef makes
// AG Grid rebuild every column (recreateColumnDefs) on every re-render of the
// sheet: each cell edit, live-update batch and loadMore page.

export const DEFAULT_COL_DEF: ColDef = {
  sortable: false, filter: true, resizable: true, editable: true, minWidth: 100, suppressSizeToFit: true,
  // A search key on a cell that isn't being edited opens search (the grid's
  // wrapper handles it) instead of starting an edit with "/".
  suppressKeyboardEvent: (p: SuppressKeyboardEventParams) => !p.editing && isSearchKey(p.event),
}

// The grid's context (AgGridReact `context`): read by cells, never re-rendering
// the column definitions. hit: the cell search found (useGridSearch).
export interface GridContext { windowStart: number; hit: { rowIndex: number; column: string } | null }

export const SEARCH_HIT_RULES = {
  'cubex-search-hit': (p: CellClassParams) => {
    const hit = (p.context as GridContext | undefined)?.hit
    return !!hit && hit.rowIndex === p.data?.__rowIndex && hit.column === p.colDef.field
  },
}

export const ROW_SELECTION: RowSelectionOptions = { mode: 'multiRow', enableSelectionWithoutKeys: true }

export const getRowId = (params: GetRowIdParams): string => params.data.__rowIndex.toString()

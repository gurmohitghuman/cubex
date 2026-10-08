import type { SheetData } from '@/utils/api'

interface ViewSetters {
  setEmptyFilter: (f: Record<string, 'empty' | 'not_empty'>) => void
  setColumnFilters: (f: Record<string, { type: 'contains'; value: string }>) => void
  setLoadedRowsCount: React.Dispatch<React.SetStateAction<number>>
  setColumnOrder: (cols: string[]) => void
}

// After a load commits its rows (useSheetLoad), apply the view state the
// payload carries: the server-persisted filters, the loaded-window size, and
// the column order.
// keepWindow: the rows were MERGED into the held window (reloadWindow.ts), which
// set loadedRowsCount itself.
export function applyLoadedView(
  data: SheetData, offset: number,
  { setEmptyFilter, setColumnFilters, setLoadedRowsCount, setColumnOrder }: ViewSetters,
  keepWindow = false,
): void {
  // No sort_state hydration: sort is a one-time physical reorder of
  // row_index (Google Sheets semantics) — there is no persistent sort view.

  // empty_filter is persisted server-side so a refresh restores the
  // user's "show only empty/non-empty" view per column.
  if (data.sheet.empty_filter) {
    try { setEmptyFilter(JSON.parse(data.sheet.empty_filter)) }
    catch (error) { console.error('Failed to parse empty filter:', error) }
  } else {
    setEmptyFilter({})
  }

  // column_filters ("text contains") — same server-persisted hydration.
  if (data.sheet.column_filters) {
    try { setColumnFilters(JSON.parse(data.sheet.column_filters)) }
    catch (error) { console.error('Failed to parse column filters:', error) }
  } else {
    setColumnFilters({})
  }

  if (!keepWindow) setLoadedRowsCount(offset + data.data.rows.length)

  // Sync column order with the columns the server reports (column_order is persisted
  // server-side, so we take its order verbatim — earlier code tried merging into the
  // previous client state, which broke renames).
  if (data.data.columns.length > 0) {
    setColumnOrder([...new Set(data.data.columns)])
  }
}

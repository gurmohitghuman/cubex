import { useEffect, useRef, type RefObject } from 'react'
import type { AgGridReact } from 'ag-grid-react'
import type { AGGridSpreadsheetProps } from './types'

// Scroll the grid to the top whenever a filter changes. The filter reload is
// SILENT (grid stays mounted, no remount) and replaces the data with the
// filter-aware FIRST page; without this, a user scrolled far down would keep
// their old scroll offset against a shorter/reset dataset — a jump or a
// blank-looking viewport. Keyed on the serialized filter state so it fires
// ONLY on a filter change (not on webhook appends / edits / other reloads).
export function useScrollTopOnFilterChange(
  gridRef: RefObject<AgGridReact>,
  emptyFilter: AGGridSpreadsheetProps['emptyFilter'],
  columnFilters: AGGridSpreadsheetProps['columnFilters'],
): void {
  const filterKey = JSON.stringify([emptyFilter ?? {}, columnFilters ?? {}])
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current === filterKey) return
    prevFilterKey.current = filterKey
    const api = gridRef.current?.api
    if (api && !api.isDestroyed?.()) api.ensureIndexVisible(0, 'top')
  }, [gridRef, filterKey])
}

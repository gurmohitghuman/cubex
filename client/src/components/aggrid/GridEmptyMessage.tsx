import React from 'react'
import type { AGGridSpreadsheetProps } from './types'

type Props = Pick<AGGridSpreadsheetProps,
  'emptyFilter' | 'columnFilters' | 'onEmptyFilterChange' | 'onColumnFilterChange' | 'rowFilterActive'
  | 'onClearAllFilters'>

// What the grid area shows when there are zero rows to render.
//
// A column filter that matches 0 rows must NOT fall through to the generic
// "Import a CSV" state: that hides the column headers — and with them the
// header menu, the only UI that can clear the filter — stranding the user
// on what looks like an empty sheet. Offer the way out directly.
// Both filter systems can hide every row; list + clear BOTH so a
// text-filter-that-matches-nothing is escapable, not just empty filters.
export const GridEmptyMessage: React.FC<Props> = ({
  emptyFilter, columnFilters, onEmptyFilterChange, onColumnFilterChange, rowFilterActive, onClearAllFilters,
}) => {
  const emptyCols = Object.keys(emptyFilter || {})
  const textCols = Object.keys(columnFilters || {})
  const filteredColumns = Array.from(new Set([...emptyCols, ...textCols]))
  if (filteredColumns.length > 0) {
    return (
      <div className="text-center text-gray-500">
        <p className="text-lg">All rows are hidden by a column filter</p>
        <p className="text-sm mb-3">Filtering on: {filteredColumns.join(', ')}</p>
        {(onClearAllFilters || onEmptyFilterChange || onColumnFilterChange) && (
          <button
            onClick={() => {
              // The whole filter, so a group or a second rule left in Filter can't keep hiding every row.
              if (onClearAllFilters) return onClearAllFilters()
              emptyCols.forEach(col => onEmptyFilterChange?.(col, null))
              textCols.forEach(col => onColumnFilterChange?.(col, null))
            }}
            className="px-3 py-1.5 text-sm border border-cube-black text-cube-black rounded hover:bg-gray-100"
          >
            Clear filter
          </button>
        )}
      </div>
    )
  }
  // A view's filter no header shows (Filter, in the bar above the grid, edits and clears it).
  if (rowFilterActive) {
    return (
      <div className="text-center text-gray-500">
        <p className="text-lg">No rows match this view</p>
        <p className="text-sm">Change or clear its filter with Filter, above the grid, or switch views.</p>
      </div>
    )
  }
  return (
    <div className="text-center text-gray-500">
      <p className="text-lg">No data to display</p>
      <p className="text-sm">Import a CSV file to get started</p>
    </div>
  )
}

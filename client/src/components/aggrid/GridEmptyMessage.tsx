import React from 'react'
import type { AGGridSpreadsheetProps } from './types'

type Props = Pick<AGGridSpreadsheetProps,
  'emptyFilter' | 'columnFilters' | 'onEmptyFilterChange' | 'onColumnFilterChange'>

// What the grid area shows when there are zero rows to render.
//
// A column filter that matches 0 rows must NOT fall through to the generic
// "Import a CSV" state: that hides the column headers — and with them the
// header menu, the only UI that can clear the filter — stranding the user
// on what looks like an empty sheet. Offer the way out directly.
// Both filter systems can hide every row; list + clear BOTH so a
// text-filter-that-matches-nothing is escapable, not just empty filters.
export const GridEmptyMessage: React.FC<Props> = ({
  emptyFilter, columnFilters, onEmptyFilterChange, onColumnFilterChange,
}) => {
  const emptyCols = Object.keys(emptyFilter || {})
  const textCols = Object.keys(columnFilters || {})
  const filteredColumns = Array.from(new Set([...emptyCols, ...textCols]))
  if (filteredColumns.length > 0) {
    return (
      <div className="text-center text-gray-500">
        <p className="text-lg">All rows are hidden by a column filter</p>
        <p className="text-sm mb-3">Filtering on: {filteredColumns.join(', ')}</p>
        {(onEmptyFilterChange || onColumnFilterChange) && (
          <button
            onClick={() => {
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
  return (
    <div className="text-center text-gray-500">
      <p className="text-lg">No data to display</p>
      <p className="text-sm">Import a CSV file to get started</p>
    </div>
  )
}

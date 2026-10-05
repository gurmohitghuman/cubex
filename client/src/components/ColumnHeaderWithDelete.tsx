import React from 'react'
import { IHeaderParams } from 'ag-grid-community'
import { X, Sparkles, Filter } from 'lucide-react'

interface ColumnHeaderWithDeleteProps extends IHeaderParams {
  onDeleteColumn: (columnId: string) => void
  onHeaderClick: (columnName: string, anchor: DOMRect) => void
  // A filter on this column hides rows: say so, or the sheet looks short.
  isFiltered?: boolean
}

export const ColumnHeaderWithDelete: React.FC<ColumnHeaderWithDeleteProps> = (params) => {
  const { displayName, column, onDeleteColumn, onHeaderClick, isFiltered } = params

  const colDef = column.getColDef()
  const columnName = (colDef.field as string) || column.getColId()
  // AI-generated columns are named "Foo (Output)" / "Foo (Data)" by the
  // server (see ai-run-start.ts). The visible header name was already
  // shortened to "Output" / "Data" in buildColumnDefs; we just need to
  // prepend a small sparkles icon so users can see at a glance which
  // columns the AI produced.
  const isAIColumn = /\s\((Output|Data)\)$/.test(columnName)

  const handleDelete = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // colId is an opaque internal identifier (col_xxxx) — the actual column name lives
    // on the colDef's `field`. Pass the name to the delete callback.
    onDeleteColumn(columnName)
  }

  // Single-click on the header opens the column dropdown (rename / sort / filter / etc.).
  // We anchor the dropdown to the header cell's DOM rect so it lines up cleanly under
  // the column. Click events bubble out of the title span and trigger this; clicks on
  // the delete X button are stopped above so they don't also open the menu.
  const handleHeaderClick = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const headerCell = (e.currentTarget.closest('.ag-header-cell') as HTMLElement | null)
    const rect = headerCell?.getBoundingClientRect()
      ?? e.currentTarget.getBoundingClientRect()
    onHeaderClick(columnName, rect)
  }

  return (
    <div className="ag-header-cell-text flex items-center justify-between w-full h-full group">
      <div
        className="truncate flex-1 cursor-pointer select-none flex items-center gap-1"
        title={displayName}
        onClick={handleHeaderClick}
      >
        {isAIColumn && (
          <Sparkles
            size={12}
            className="opacity-60 flex-shrink-0"
            aria-label="AI-generated column"
          />
        )}
        <span className="truncate">{displayName}</span>
        {isFiltered && (
          <Filter size={12} className="flex-shrink-0 text-cube-black" aria-label="Filtered"><title>Filtered: some rows are hidden</title></Filter>
        )}
      </div>

      <div className="flex items-center space-x-1">
        {/* Delete button. Click-to-delete is intentionally separate from the
            header-click-to-open-menu behavior; e.stopPropagation in handleDelete
            prevents the menu from opening alongside the delete confirmation. */}
        <button
          onClick={handleDelete}
          className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 p-0.5 hover:bg-red-100 rounded text-red-600 hover:text-red-700 flex-shrink-0"
          title={`Delete column "${displayName}"`}
          aria-label={`Delete column ${displayName}`}
        >
          <X className="h-3 w-3" />
        </button>

        {/* Sort indicator. Sort itself is now triggered from the dropdown
            (single-click the header), but we still surface the current
            direction here so the user knows what's active. */}
        {params.enableSorting && (
          <div className="text-gray-400 text-xs flex-shrink-0">
            {column.getSort() === 'asc' && '↑'}
            {column.getSort() === 'desc' && '↓'}
          </div>
        )}
      </div>
    </div>
  )
}

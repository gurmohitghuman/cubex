import React from 'react'
import { ColDef } from 'ag-grid-community'
import { ColumnHeaderWithDelete } from '../ColumnHeaderWithDelete'
import { LoadingCellRenderer } from '../LoadingCellRenderer'
import { WebhookMarkerCell } from '../webhook/WebhookMarkerCell'
import { AddColumnHeader } from '../AddColumnHeader'
import type { ColumnType } from '@/utils/api/types'

interface BuildColumnDefsArgs {
  columns: string[]
  // Authoritative per-column type (server, run-record derived). Drives the header
  // icons (🔗 HTTP master, 📎 HTTP extracted) and the AI suffix-only header. Absent → plain.
  columnTypes: Record<string, ColumnType>
  columnWidths: Record<string, number>
  onDeleteColumn?: (columnName: string) => void | Promise<void>
  onAddColumn?: () => void | Promise<void>
  colIdFor: (name: string) => string
  handleHeaderColumnDelete: (columnId: string) => void
  openColumnMenu: (columnName: string, anchor: DOMRect) => void
  // Active filters, keyed by column name: their headers show a filter icon.
  emptyFilter?: Record<string, unknown>
  columnFilters?: Record<string, unknown>
}

// Build the colDef array AG Grid renders from. Extracted from AGGridSpreadsheet so the
// parent component stays under the 200-line cap.
//
// Includes a pinned "#" row-number column on the left, the data columns in the middle,
// and an optional pinned "Add Column" column on the right.
export const buildColumnDefs = (args: BuildColumnDefsArgs): ColDef[] => {
  const {
    columns, columnTypes, columnWidths,
    onDeleteColumn, onAddColumn, colIdFor, handleHeaderColumnDelete, openColumnMenu,
    emptyFilter = {}, columnFilters = {},
  } = args

  const rowNumbersColumn: ColDef = {
    headerName: '#',
    field: '__rowNumber',
    width: 40, minWidth: 35, maxWidth: 45,
    pinned: 'left',
    suppressMovable: true, lockPinned: true,
    resizable: false, sortable: false, filter: false, editable: false,
    cellRenderer: (params: any) => params.node.rowIndex + 1,
    cellStyle: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontWeight: '500', color: '#6b7280', fontSize: '12px',
    },
  }

  const dataColumns = columns.map((column) => {
    const columnType = columnTypes[column]

    // Header shows the FULL column name (e.g. "What they do (Output)") so it
    // matches what the rename dialog and the underlying data use — showing just
    // the "Output"/"Data" suffix was confusing (the user couldn't tell which AI
    // column was which). HTTP columns keep their type prefix.
    let headerName = column
    if (columnType === 'http-master') headerName = `🔗 ${column}`
    else if (columnType === 'http-extracted') headerName = `📎 ${column}`
    else if (columnType === 'webhook-source') headerName = `📥 ${column}`

    // The webhook marker column is READ-ONLY row provenance — it shows the
    // receipt time and a click opens the raw payload. Not an autosave target.
    const isWebhookSource = columnType === 'webhook-source'

    const colDef: ColDef = {
      // Stable colId — survives renames so AG Grid keeps the column in place rather
      // than treating a rename as remove+add. See useColIdMap.
      colId: colIdFor(column),
      field: column,
      headerName,
      // webhook-source is read-only (provenance marker); all other columns edit.
      editable: !isWebhookSource,
      // Use AG Grid's built-in large-text editor as a popup. Single-click on
      // the cell pops out a textarea anchored to the cell, sized large enough
      // to read multi-line / multi-paragraph content (AI Output cells, long
      // CSV values, etc.). User can edit in place; Enter saves, Esc cancels.
      // For short cells (one word) this still opens but feels native.
      cellEditor: 'agLargeTextCellEditor',
      cellEditorPopup: true,
      cellEditorParams: {
        // Wider textarea than the cell — gives breathing room for long content
        // without making the popup huge for narrow columns. AG Grid sizes the
        // popup based on these. 480 cols × 8 rows ≈ comfortable paragraph view.
        maxLength: 200000,
        rows: 8,
        cols: 60,
      },
      // The grid NEVER sorts: sort is a one-time physical reorder of
      // row_index on the server (Google Sheets semantics), triggered from the
      // header menu. Rows always render in row_index order, so editing a cell
      // can't move its row.
      sortable: false,
      resizable: true,
      // Cubex has no column pinning. Without this, dropping a dragged column
      // onto a pinned edge (the "Add Column" area right, "#" left) pins it
      // into that section instead of reordering it within the data columns.
      lockPinned: true,
      filter: true,
      width: columnWidths[column] || 150,
      suppressHeaderMenuButton: false,
      ...(onDeleteColumn && {
        headerComponent: ColumnHeaderWithDelete,
        headerComponentParams: {
          onDeleteColumn: handleHeaderColumnDelete,
          onHeaderClick: openColumnMenu,
          isFiltered: column in emptyFilter || column in columnFilters,
        },
      }),
      // Webhook marker column uses its own read-only renderer (marker or muted —);
      // every other column uses the standard loading/typing renderer.
      cellRenderer: isWebhookSource ? WebhookMarkerCell : LoadingCellRenderer,
      cellStyle: (params: any) => {
        const value = params.value || ''
        const style: any = {}
        // Webhook marker cell: muted + clickable (opens the raw payload panel).
        if (isWebhookSource) {
          if (value) style.cursor = 'pointer'
          style.backgroundColor = '#f8fafc'; style.color = '#475569'
          return style
        }
        if (value.includes('⏳')) { style.backgroundColor = '#f3f4f6'; style.color = '#6b7280' }
        // AI Data column styling (clickable). startsWith('📊') matches the
        // server's '📊 Searched N sources…' summary (and legacy '📊 Scraped').
        if (column.endsWith(' (Data)') && value.startsWith('📊')) {
          style.cursor = 'pointer'; style.backgroundColor = '#eff6ff'
        }
        if (value.includes('❌')) { style.backgroundColor = '#fef2f2'; style.color = '#dc2626' }
        if (value.includes('✅')) { style.backgroundColor = '#f0fdf4'; style.color = '#16a34a' }
        return Object.keys(style).length > 0 ? style : undefined
      },
    }

    return colDef
  })

  const addColumnColumn: ColDef = {
    headerName: 'Add Column',
    field: '__addColumn',
    width: 140, minWidth: 140, maxWidth: 160,
    pinned: 'right',
    suppressMovable: true, lockPinned: true,
    resizable: false, sortable: false, filter: false, editable: false,
    headerComponent: AddColumnHeader,
    headerComponentParams: { onAddColumn },
    cellRenderer: () => '',
    cellStyle: { backgroundColor: '#f8fafc', border: 'none' },
  }

  const allColumns = [rowNumbersColumn, ...dataColumns]
  if (onAddColumn) allColumns.push(addColumnColumn)
  return allColumns
}

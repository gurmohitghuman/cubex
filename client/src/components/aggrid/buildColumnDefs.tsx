import React from 'react'
import { ColDef } from 'ag-grid-community'
import { ColumnHeaderWithDelete } from '../ColumnHeaderWithDelete'
import { LoadingCellRenderer } from '../LoadingCellRenderer'
import { WebhookMarkerCell } from '../webhook/WebhookMarkerCell'
import { AddColumnHeader } from '../AddColumnHeader'
import { SEARCH_HIT_RULES, type GridContext } from './gridOptions'
import type { ColumnType } from '@/utils/api/types'
import type { ColumnSpend, SheetAutorun } from '@/utils/api/types-autorun'
import type { CleanColumnView } from '@/utils/api/clean'
import type { FormulaColumnView } from '@/utils/api/formula'
import type { LookupColumnView } from '@/utils/api/lookup'

interface BuildColumnDefsArgs {
  columns: string[]
  // Authoritative per-column type (server, run-record derived). Drives the header
  // icons (🔗 HTTP master, 📎 HTTP extracted, the enrichment status column's
  // DatabaseZap in ColumnHeaderWithDelete). Absent → plain.
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
  // Auto-run and spend per column: the header's ⚡ and its tooltip.
  autorun?: SheetAutorun
  columnSpend?: Record<string, ColumnSpend>
  // Clean data columns' setups: the header's brush icon and its hover note.
  cleanColumns?: Record<string, CleanColumnView>
  // Formula columns' setups: the header's formula icon and its hover note.
  formulaColumns?: Record<string, FormulaColumnView>
  // The active view's hidden columns: set as AG Grid's `hide`, so they stay in
  // the grid's column state (a column move keeps their place in column_order).
  hiddenColumns?: ReadonlySet<string>
  // Lookup columns' setups: the header's lookup icon and its hover note.
  lookupColumns?: Record<string, LookupColumnView>
  // Column descriptions: the header's note.
  columnDescriptions?: Record<string, string>
  // Digits of the largest row number held: the "#" column's width (a deep window's are long).
  rowNumberDigits?: number
}

// Room for a row number of `digits` digits (40 px holds up to three).
export const rowNumberWidth = (digits: number): number => Math.max(40, 16 + digits * 8)

// Build the colDef array AG Grid renders from. Extracted from AGGridSpreadsheet so the
// parent component stays under the 200-line cap.
//
// Includes a pinned "#" row-number column on the left, the data columns in the middle,
// and an optional pinned "Add Column" column on the right.
export const buildColumnDefs = (args: BuildColumnDefsArgs): ColDef[] => {
  const {
    columns, columnTypes, columnWidths,
    onDeleteColumn, onAddColumn, colIdFor, handleHeaderColumnDelete, openColumnMenu,
    emptyFilter = {}, columnFilters = {}, autorun, columnSpend, cleanColumns, formulaColumns, hiddenColumns,
    lookupColumns, columnDescriptions, rowNumberDigits = 1,
  } = args

  const rowNumbersColumn: ColDef = {
    headerName: '#',
    field: '__rowNumber',
    width: rowNumberWidth(rowNumberDigits), minWidth: 35, maxWidth: 90,
    pinned: 'left',
    suppressMovable: true, lockPinned: true,
    resizable: false, sortable: false, filter: false, editable: false,
    // The row's place in the view: the held window can start deep (search jumped).
    cellRenderer: (params: any) => params.node.rowIndex + 1 + ((params.context as GridContext)?.windowStart ?? 0),
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
    else if (columnType === 'http-extracted' || columnType === 'waterfall-step') headerName = `📎 ${column}`
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
      // Always a boolean: AG Grid applies a defined `hide` on every columnDefs update.
      hide: !!hiddenColumns?.has(column),
      suppressHeaderMenuButton: false,
      ...(onDeleteColumn && {
        headerComponent: ColumnHeaderWithDelete,
        headerComponentParams: {
          onDeleteColumn: handleHeaderColumnDelete,
          onHeaderClick: openColumnMenu,
          isFiltered: column in emptyFilter || column in columnFilters,
          columnType,
          autorun: autorun?.columns[column],
          spend: columnSpend?.[column],
          clean: cleanColumns?.[column],
          formula: formulaColumns?.[column],
          lookup: lookupColumns?.[column],
          description: columnDescriptions?.[column],
        },
      }),
      // Webhook marker column uses its own read-only renderer (marker or muted —);
      // every other column uses the standard loading/typing renderer.
      cellRenderer: isWebhookSource ? WebhookMarkerCell : LoadingCellRenderer,
      cellClassRules: SEARCH_HIT_RULES,
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
        // ⏭️ Not found / Budget ran out / No data: no answer, muted (not an error).
        if (value.startsWith('⏭️')) { style.backgroundColor = '#f8fafc'; style.color = '#64748b' }
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

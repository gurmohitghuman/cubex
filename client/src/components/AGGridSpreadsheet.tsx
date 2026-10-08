// Over 200 lines: the AG Grid wiring (props, column defs, grid options, menus)
// in one place; the logic itself lives in the aggrid/ hooks it calls.
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import 'ag-grid-community/styles/ag-theme-alpine.css'
import './ag-grid-custom.css'
import './aggrid/gridModules' // registers only the AG Grid modules the grid uses

import { useColIdMap } from './aggrid/useColIdMap'
import { useColumnWidths } from './aggrid/useColumnWidths'
import { useGridHandlers } from './aggrid/useGridHandlers'
import { buildColumnDefs } from './aggrid/buildColumnDefs'
import { HeaderContextMenu, type MenuState } from './aggrid/HeaderContextMenu'
import { RenameColumnPopover } from './aggrid/RenameColumnPopover'
import { DeleteConfirms } from './aggrid/DeleteConfirms'
import { DEFAULT_COL_DEF, ROW_SELECTION, getRowId } from './aggrid/gridOptions'
import { useRowData } from './aggrid/useRowData'
import { useClearRowSelection } from './aggrid/useClearRowSelection'
import { useScrollTopOnFilterChange } from './aggrid/useScrollTopOnFilterChange'
import { useRegisterViewport } from './aggrid/useRegisterViewport'
import { useHeaderContextMenu } from './aggrid/useHeaderContextMenu'
import { GridEmptyMessage } from './aggrid/GridEmptyMessage'
import type { AGGridSpreadsheetProps } from './aggrid/types'

export const AGGridSpreadsheet: React.FC<AGGridSpreadsheetProps> = (props) => {
  const {
    columns, data, totalRows, onCellEdit, onLoadMore, className = '',
    onSortChange, onRenameColumn, onDeleteColumn, onDeleteRows, onAddColumn,
    emptyFilter, onEmptyFilterChange, columnFilters, onColumnFilterChange,
    onSelectedRowsChange, onCellClick,
    onRunHTTPForColumn, onRunHTTPForRows, onRunHTTPForMissingOrError,
    onRunAIForColumn, onRunAIMissingOrError, onEditAIColumn, canEditAIColumn,
    columnTypes = {},
    activeHTTPRunsByColumn = {}, activeAIRunsByColumn = {},
    onStopRunForColumn, onColumnReorder, sheetId,
    lastRenamedColumn = null, registerClearSelection, registerViewport,
  } = props

  const gridRef = useRef<AgGridReact>(null)
  const [selectedRows, setSelectedRows] = useState<number[]>([])

  const { nameToColIdRef, colIdFor } = useColIdMap(lastRenamedColumn)
  // Pass columns + the rename signal so width state self-heals on rename/delete
  // (it's the single owner of the width localStorage key — see useColumnWidths).
  const { columnWidths, setColumnWidths } = useColumnWidths(sheetId, columns, lastRenamedColumn)

  const [menu, setMenu] = useState<MenuState>(null)
  const [renaming, setRenaming] = useState<{ x: number; y: number; oldName: string; value: string } | null>(null)
  const [confirmDeleteColumn, setConfirmDeleteColumn] = useState<string | null>(null)
  const [confirmDeleteRows, setConfirmDeleteRows] = useState<number[] | null>(null)

  const rowData = useRowData(data)

  // Disable row animation while any AI/HTTP run is active (perf fix #1). Streaming
  // result cells arrive in batched bursts; animating each one makes AG Grid recalc
  // layout per flush for no value. Re-enabled the moment all runs finish.
  const hasActiveRun = useMemo(
    () => Object.keys(activeHTTPRunsByColumn).length > 0 || Object.keys(activeAIRunsByColumn).length > 0,
    [activeHTTPRunsByColumn, activeAIRunsByColumn],
  )

  // The header's × asks first, like the header menu: a column delete is permanent.
  const handleHeaderColumnDelete = useCallback((columnId: string) => {
    setConfirmDeleteColumn(columnId)
  }, [])

  // NO custom Delete/Backspace handler — it was structurally broken. AG Grid
  // v34 processes the keypress INTERNALLY first (Delete/Backspace on an
  // editable cell → rowNode.setDataValue(column, null, "cellClear")) and only
  // THEN dispatches the userland cellKeyDown event — so a handler there reads
  // the already-nulled cell, "sees it empty", and skips persisting: the clear
  // showed in the UI but reappeared on refresh. Persistence is now driven by
  // onCellValueChanged (see useGridHandlers), which AG Grid fires for EVERY
  // value mutation — native key clears, editor commits, all of it.

  // Open the column dropdown anchored to the header cell's DOM rect. Shared by
  // left-click (custom header) and right-click (context menu).
  const openColumnMenu = useCallback((columnName: string, anchor: DOMRect) => {
    setMenu({
      x: anchor.left, y: anchor.bottom,
      columnId: columnName,
      // selectedRows already holds persistent data row indices (__rowIndex) —
      // see onSelectionChanged in useGridHandlers. No positional re-mapping.
      selectedRowIndices: selectedRows,
    })
  }, [selectedRows])

  // Commit any open cell editor BEFORE the sort runs. Sorting goes through a
  // waitForSaves barrier upstream (useSheetView) that drains unsavedChanges, but
  // an open editor's value isn't in that queue yet — and the FullPageLoader swap
  // then unmounts the grid, committing the editor AFTER the sort rewrote
  // row_index, so the late onCellValueChanged lands on the wrong/stale row.
  // stopEditing(false) = commit (not cancel) → onCellValueChanged fires
  // synchronously → the edit is in the queue before the barrier sees it.
  const handleSortChange = useCallback((columnId: string, direction?: 'asc' | 'desc' | null) => {
    gridRef.current?.api?.stopEditing(false)
    onSortChange?.(columnId, direction)
  }, [onSortChange])

  const columnDefs = useMemo(() => buildColumnDefs({
    columns, columnTypes, columnWidths, emptyFilter, columnFilters,
    onDeleteColumn, onAddColumn, colIdFor, handleHeaderColumnDelete, openColumnMenu,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [columns, columnTypes, columnWidths, emptyFilter, columnFilters, onDeleteColumn, onAddColumn, openColumnMenu])

  const {
    onGridReady, onCellValueChanged, onCellClicked, onSelectionChanged,
    onColumnMoved, onColumnResized, onBodyScrollEnd, onNewColumnsLoaded,
  } = useGridHandlers({
    columns, data, totalRows, rowData, nameToColIdRef, colIdFor,
    setColumnWidths, setSelectedRows,
    onCellEdit, onCellClick, onSelectedRowsChange, onColumnReorder, onLoadMore,
  })

  const clearRowSelection = useClearRowSelection(gridRef, setSelectedRows, onSelectedRowsChange, registerClearSelection)
  useScrollTopOnFilterChange(gridRef, emptyFilter, columnFilters)
  useRegisterViewport(gridRef, registerViewport)
  const { wrapperRef, onHeaderContextMenu } = useHeaderContextMenu(openColumnMenu)

  if (rowData.length === 0) {
    // The root stays a <div> HERE, in the same position as the grid wrapper
    // below, so React reuses one DOM node across empty <-> grid: the header
    // context-menu listener (useHeaderContextMenu) is attached to it only once.
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ height: '100%', width: '100%' }}>
        <GridEmptyMessage
          emptyFilter={emptyFilter} columnFilters={columnFilters}
          onEmptyFilterChange={onEmptyFilterChange} onColumnFilterChange={onColumnFilterChange}
        />
      </div>
    )
  }

  return (
    <div ref={wrapperRef} className={`ag-theme-alpine ${className}`} style={{ height: '100%', width: '100%' }}>
      <AgGridReact
        ref={gridRef}
        rowData={rowData} columnDefs={columnDefs}
        defaultColDef={DEFAULT_COL_DEF}
        animateRows={!hasActiveRun} enableCellTextSelection={true} enableBrowserTooltips={true}
        rowSelection={ROW_SELECTION}
        // Double-click opens the large-text popup editor (AG Grid default).
        // Single click selects the cell so users can copy values without
        // accidentally entering edit mode.
        domLayout='normal' headerHeight={36} rowHeight={32}
        // rowBuffer: rows AG Grid pre-paints above/below the viewport (default
        // 10). On Firefox fast-flick scroll, APZ moves the compositor layer while
        // our main-thread handler is still mounting rows; when the buffer runs out
        // the unmounted area paints as page background (the "white flash").
        // Higher trades memory + initial paint for less white. Measured: 30 is
        // the sweet spot; 50+ is worse (more DOM rows, more restyle work).
        rowBuffer={30}
        onGridReady={onGridReady}
        onCellClicked={onCellClicked}
        onCellValueChanged={onCellValueChanged}
        onSelectionChanged={onSelectionChanged}
        onColumnMoved={onColumnMoved} onColumnResized={onColumnResized} onNewColumnsLoaded={onNewColumnsLoaded}
        onBodyScrollEnd={onBodyScrollEnd}
        // Like a spreadsheet: Enter after typing moves down; clicking away saves the edit.
        enterNavigatesVerticallyAfterEdit={true} stopEditingWhenCellsLoseFocus={true}
        suppressContextMenu={true}
        onColumnHeaderContextMenu={onHeaderContextMenu}
        // Column names are FLAT keys in row data. Without this, AG Grid treats
        // a dot in a field ("price.usd" — common in CSV headers) as nested
        // access (data.price.usd → undefined) and the whole column renders
        // blank while export/AI see the data fine.
        suppressFieldDotNotation={true}
        suppressDragLeaveHidesColumns={true} maintainColumnOrder={true}
        getRowId={getRowId}
        alwaysShowHorizontalScroll={true} suppressAutoSize={true} skipHeaderOnAutoSize={true}
      />

      <HeaderContextMenu
        menu={menu} setMenu={setMenu} setRenaming={setRenaming}
        columnTypes={columnTypes}
        emptyFilter={emptyFilter} columnFilters={columnFilters}
        setConfirmDeleteColumn={setConfirmDeleteColumn}
        setConfirmDeleteRows={setConfirmDeleteRows}
        activeHTTPRunsByColumn={activeHTTPRunsByColumn}
        activeAIRunsByColumn={activeAIRunsByColumn}
        onSortChange={handleSortChange}
        onEmptyFilterChange={onEmptyFilterChange}
        onColumnFilterChange={onColumnFilterChange}
        onDeleteColumn={onDeleteColumn} onDeleteRows={onDeleteRows}
        onRunHTTPForColumn={onRunHTTPForColumn}
        onRunHTTPForRows={onRunHTTPForRows}
        onRunHTTPForMissingOrError={onRunHTTPForMissingOrError}
        onRunAIForColumn={onRunAIForColumn}
        onRunAIMissingOrError={onRunAIMissingOrError}
        onEditAIColumn={onEditAIColumn} canEditAIColumn={canEditAIColumn}
        onStopRunForColumn={onStopRunForColumn}
      />

      <RenameColumnPopover state={renaming} setState={setRenaming} onRenameColumn={onRenameColumn} />

      <DeleteConfirms
        confirmDeleteColumn={confirmDeleteColumn} setConfirmDeleteColumn={setConfirmDeleteColumn}
        confirmDeleteRows={confirmDeleteRows} setConfirmDeleteRows={setConfirmDeleteRows}
        clearRowSelection={clearRowSelection}
        onDeleteColumn={onDeleteColumn} onDeleteRows={onDeleteRows}
      />
    </div>
  )
}

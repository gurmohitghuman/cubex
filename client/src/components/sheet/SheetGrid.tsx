import React, { useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { AGGridSpreadsheet } from '@/components/AGGridSpreadsheet'
import { AIRun, HTTPRun, SheetData, Sheet } from '@/utils/api'
import type { ColumnType } from '@/utils/api/types'
import { useSheetGridRunActions } from '@/hooks/sheet/useSheetGridRunActions'

type RunByColumn = Record<string, { runId: string; status: 'running' | 'paused' | 'pending' }>

export interface SheetGridProps {
  activeSheet: Sheet | null
  forceUpdate: number
  columns: string[]
  rows: SheetData['data']['rows']
  totalRows: number
  emptyFilter: Record<string, 'empty' | 'not_empty'>
  columnFilters: Record<string, { type: 'contains'; value: string }>
  lastRenamedColumn: { from: string; to: string; at: number } | null
  columnTypes: Record<string, ColumnType>
  activeHTTPRuns: HTTPRun[]
  activeAIRunsList: AIRun[]
  activeHTTPRunsByColumn: RunByColumn
  activeAIRunsByColumn: RunByColumn
  // Columns written by structured (multi-column) AI runs: no edit-instructions item.
  structuredAIColumns?: ReadonlySet<string>
  onCellEdit: (rowIndex: number, column: string, value: string) => void
  onCellClick: (rowIndex: number, columnName: string, value?: unknown) => void
  onLoadMore: (offset: number, limit?: number) => Promise<void> | void
  onSortChange: (columnId: string, direction?: 'asc' | 'desc' | null) => void
  onEmptyFilterChange: (column: string, value: 'empty' | 'not_empty' | null) => void
  onColumnFilterChange: (column: string, value: string | null) => void
  onSelectedRowsChange: (rows: number[]) => void
  onRenameColumn: (oldName: string, newName: string) => boolean | void | Promise<boolean | void>
  onDeleteColumn: (columnName: string) => void | Promise<void>
  onDeleteRows: (rows: number[]) => void | Promise<void>
  onColumnReorder: (newOrder: string[]) => void | Promise<void>
  onAddColumn: () => void
  setShowAddColumnModal: (open: boolean) => void
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  fetchActiveHTTPRuns: (sheetId: string) => unknown
  fetchActiveAIRuns: (sheetId: string) => unknown
  reloadSheetData?: (sheetId: string) => unknown
  // The LIVE per-sheet row_generation (seeded from sheetData on every load) —
  // used by "Run Selected Rows" reruns to fence stale-index writes. NOT
  // activeSheet.row_generation, which is table-list metadata that doesn't
  // refresh after a sort.
  rowGenerationRef?: React.MutableRefObject<Map<string, number>>
  // Forwarded to AGGridSpreadsheet so the topbar delete confirm can clear the
  // grid selection through deselectAll (the selection source of truth).
  registerClearSelection?: (clear: (() => void) | null) => void
  // Forwarded too: background reloads refresh the rows around the viewport.
  registerViewport?: (get: (() => number | null) | null) => void
}

export const SheetGrid: React.FC<SheetGridProps> = (props) => {
  const {
    activeSheet, forceUpdate, columns, rows, totalRows, emptyFilter, columnFilters,
    lastRenamedColumn, columnTypes, activeHTTPRuns, activeAIRunsList,
    activeHTTPRunsByColumn, activeAIRunsByColumn, structuredAIColumns,
    onCellEdit, onCellClick, onLoadMore, onSortChange, onEmptyFilterChange, onColumnFilterChange,
    onSelectedRowsChange, onRenameColumn, onDeleteColumn, onDeleteRows,
    onColumnReorder, onAddColumn, setShowAddColumnModal, setupSSEConnection,
    fetchActiveHTTPRuns, fetchActiveAIRuns, reloadSheetData, rowGenerationRef, registerClearSelection, registerViewport,
  } = props

  const actions = useSheetGridRunActions({
    activeSheet, activeAIRunsList, activeHTTPRuns,
    setShowAddColumnModal, setupSSEConnection,
    fetchActiveHTTPRuns, fetchActiveAIRuns, reloadSheetData, rowGenerationRef,
  })

  // "Run All Rows" clears the column's current results first and spends credits
  // or requests on every row again, so it asks before starting.
  // columnName: the AI header clicked (a structured run reruns from any column).
  const [confirmRunAll, setConfirmRunAll] = useState<{ kind: 'ai' | 'http'; column: string; columnName?: string } | null>(null)
  const runAll = async () => {
    const c = confirmRunAll
    setConfirmRunAll(null)
    if (c?.kind === 'ai') await actions.handleRunAIForColumn(c.column, c.columnName)
    else if (c) await actions.handleRunHTTPForColumn(c.column)
  }

  return (
    <div className="flex flex-col h-full">
      <ConfirmDialog
        isOpen={!!confirmRunAll}
        title="Run all rows again?"
        message={confirmRunAll?.kind === 'ai'
          ? `"${confirmRunAll.column}" will be cleared and filled again on every row, using your OpenRouter credits. To fill only empty or failed rows, use "Run Missing or Errors" instead.`
          : `"${confirmRunAll?.column ?? ''}" will call the API again for every row and replace the current results.`}
        confirmText="Run all rows"
        onConfirm={runAll}
        onCancel={() => setConfirmRunAll(null)}
      />
      <div className="flex-1 min-h-0">
        <AGGridSpreadsheet
          key={`${activeSheet?.id}_${forceUpdate}`}
          sheetId={activeSheet?.id}
          columns={columns}
          data={rows}
      totalRows={totalRows}
      onCellEdit={onCellEdit}
      onCellClick={onCellClick}
      onLoadMore={onLoadMore}
      onSortChange={onSortChange}
      lastRenamedColumn={lastRenamedColumn}
      emptyFilter={emptyFilter}
      columnFilters={columnFilters}
      onEmptyFilterChange={onEmptyFilterChange}
      onColumnFilterChange={onColumnFilterChange}
      onSelectedRowsChange={onSelectedRowsChange}
      onRenameColumn={onRenameColumn}
      onDeleteColumn={(col) => actions.handleDeleteColumnWithWidthCleanup(col, onDeleteColumn)}
      onDeleteRows={onDeleteRows}
      onRunHTTPForColumn={(column) => setConfirmRunAll({ kind: 'http', column })}
      onRunHTTPForMissingOrError={actions.handleRunHTTPMissingOrError}
      onRunHTTPForRows={actions.handleRunHTTPForRows}
      onRunAIForColumn={(column, columnName) => setConfirmRunAll({ kind: 'ai', column, columnName })}
      onRunAIMissingOrError={actions.handleRunAIMissingOrError}
      onEditAIColumn={actions.handleEditAIColumn}
      canEditAIColumn={(column) => !structuredAIColumns?.has(column)}
      columnTypes={columnTypes}
      activeHTTPRunsByColumn={activeHTTPRunsByColumn}
      activeAIRunsByColumn={activeAIRunsByColumn}
      onStopRunForColumn={actions.handleStopRunForColumn}
      onColumnReorder={onColumnReorder}
      onAddColumn={onAddColumn}
      registerClearSelection={registerClearSelection}
      registerViewport={registerViewport}
      className="w-full h-full"
    />
      </div>
      {/* The add-rows control moved to the consolidated bottom bar (SheetTabsBar) in
          SheetPage so it sits beside the sheet tabs and stays visible even on an empty
          sheet (which renders SheetEmptyState, not this grid). */}
    </div>
  )
}

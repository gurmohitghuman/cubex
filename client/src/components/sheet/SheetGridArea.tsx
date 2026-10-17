import React, { type MutableRefObject } from 'react'
import type { ColumnFilters } from '@/lib/filters'
import { Sheet, SheetData } from '@/utils/api'
import { SheetGrid } from './SheetGrid'
import { SheetEmptyState } from './SheetEmptyState'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import type { useActiveRuns } from '@/hooks/sheet/useActiveRuns'
import type { useCellOps } from '@/hooks/sheet/useCellOps'
import type { useColumnOps } from '@/hooks/sheet/useColumnOps'
import type { useSheetModals } from '@/hooks/sheet/useSheetModals'
import type { useSheetSSE } from '@/hooks/sheet/useSheetSSE'
import type { useSheetView } from '@/hooks/sheet/useSheetView'
import type { SheetViews } from '@/hooks/sheet/useSheetViews'
import { rowFilterOf } from '@/lib/views'
import type { useGridHandles } from '@/hooks/sheet/useGridHandles'
import type { useAutorun } from '@/hooks/sheet/useAutorun'
import type { gridAreaMode } from '@/hooks/sheet/gridAreaMode'
import type { ColumnType } from '@/utils/api/types'

// One empty map, not a new {} per render: a new object rebuilds every grid column.
const NO_COLUMN_TYPES: Record<string, ColumnType> = {}

interface Props {
  gridArea: ReturnType<typeof gridAreaMode>
  activeSheet: Sheet | null
  sheetData: SheetData | null
  totalDisplayedRows: number
  emptyFilter: Record<string, 'empty' | 'not_empty'>
  columnFilters: ColumnFilters
  onEmptyFilterChange: React.ComponentProps<typeof SheetGrid>['onEmptyFilterChange']
  onColumnFilterChange: React.ComponentProps<typeof SheetGrid>['onColumnFilterChange']
  loadMoreData: React.ComponentProps<typeof SheetGrid>['onLoadMore']
  columnOps: ReturnType<typeof useColumnOps>
  cellOps: ReturnType<typeof useCellOps>
  view: ReturnType<typeof useSheetView>
  // Saved views: the hidden columns and "Hide column".
  views: SheetViews
  runs: ReturnType<typeof useActiveRuns>
  modals: ReturnType<typeof useSheetModals>
  grid: ReturnType<typeof useGridHandles>
  autorun: ReturnType<typeof useAutorun>
  sse: ReturnType<typeof useSheetSSE>
  rowGenerationRef: MutableRefObject<Map<string, number>>
  silentReload: (sheetId: string) => Promise<void> | void
  // The read-only webhook marker column (clicking a cell opens its raw payload).
  webhookColumn: string | undefined
  onWebhookCell: (rowIndex: number) => void
}

// The sheet's main area: the loader, the import empty state, or the grid wired
// to the page's hooks (cells, columns, runs, auto-run, the drawers it opens).
export const SheetGridArea: React.FC<Props> = (p) => {
  const {
    gridArea, activeSheet, sheetData, totalDisplayedRows, emptyFilter, columnFilters, onEmptyFilterChange,
    onColumnFilterChange, loadMoreData, columnOps, cellOps, view, views, runs, modals, grid, autorun, sse,
    rowGenerationRef, webhookColumn,
  } = p
  return (
    <div className="flex-1 overflow-hidden">
      {gridArea === 'loading' ? (
        <LoadingSpinner size="md" message="Loading spreadsheet…" className="h-full" />
      ) : gridArea === 'import' ? (
        <SheetEmptyState onImport={() => modals.setShowImportModal(true)}
          onAddColumn={() => modals.setShowNewColumnModal(true)} />
      ) : (
        <SheetGrid
          activeSheet={activeSheet} forceUpdate={0}
          columns={columnOps.columnHeaders} rows={view.sortedRows} totalRows={totalDisplayedRows}
          emptyFilter={emptyFilter}
          columnFilters={columnFilters}
          lastRenamedColumn={columnOps.lastRenamedColumn}
          columnTypes={sheetData?.data.columnTypes ?? NO_COLUMN_TYPES}
          autorun={autorun.view} columnSpend={autorun.spend} onAutorunAction={autorun.onAction}
          cleanColumns={sheetData?.data.cleanColumns} onOpenClean={modals.openClean}
          formulaColumns={sheetData?.data.formulaColumns} onOpenFormula={modals.openFormula}
          activeHTTPRuns={runs.httpRuns} activeAIRunsList={runs.aiRuns}
          activeHTTPRunsByColumn={runs.httpByColumn} activeAIRunsByColumn={runs.aiByColumn}
          structuredAIColumns={runs.aiStructuredColumns}
          onCellEdit={cellOps.handleOptimizedCellEdit}
          onCellClick={(rowIndex, columnName, value) => {
            // Clicking the read-only webhook marker cell opens the raw payload.
            if (webhookColumn && columnName === webhookColumn) { p.onWebhookCell(rowIndex); return }
            view.handleCellClick(rowIndex, columnName, value)
          }}
          onLoadMore={loadMoreData} onSortChange={view.handleSortChange}
          onEmptyFilterChange={onEmptyFilterChange}
          onColumnFilterChange={onColumnFilterChange}
          hiddenColumns={views.hiddenSet} onHideColumn={views.hideColumn}
          rowFilterActive={rowFilterOf(sheetData).length > 0}
          onSelectedRowsChange={cellOps.setSelectedRowIndices}
          onRenameColumn={columnOps.handleRenameColumn}
          onDeleteColumn={columnOps.handleColumnDelete}
          onDeleteRows={cellOps.handleDeleteRows}
          onColumnReorder={columnOps.handleColumnReorder}
          onAddColumn={() => modals.setShowNewColumnModal(true)}
          registerClearSelection={grid.registerClearSelection} registerViewport={grid.registerViewport}
          onOpenEnrichment={modals.openEnrichment} onSaveSetup={modals.openSaveSetup}
          setShowAddColumnModal={modals.setShowAddColumnModal}
          setupSSEConnection={sse.setupSSEConnection}
          fetchActiveHTTPRuns={runs.fetchHTTPRuns} fetchActiveAIRuns={runs.fetchAIRuns}
          // Live generation source for the selected-rows rerun fence (P2-5) —
          // the same ref every write path uses, seeded from sheetData on load.
          rowGenerationRef={rowGenerationRef}
          // SILENT reload (no FullPageLoader flash; scroll + selection kept). Its
          // side-load chain still runs reconnectToActiveRuns to (re)attach SSE.
          // Used by the run/rerun/stop menu actions in useSheetGridRunActions.
          reloadSheetData={p.silentReload}
        />
      )}
    </div>
  )
}

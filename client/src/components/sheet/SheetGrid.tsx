// Over 200 lines: the grid's props and its run, column and setup actions, wired as one piece.
import React from 'react'
import type { ColumnFilter, ColumnFilters } from '@/lib/filters'
import { AGGridSpreadsheet } from '@/components/AGGridSpreadsheet'
import { AIRun, HTTPRun, SheetData, Sheet } from '@/utils/api'
import type { ColumnType } from '@/utils/api/types'
import type { ColumnSpend, SheetAutorun } from '@/utils/api/types-autorun'
import { useSheetGridRunActions } from '@/hooks/sheet/useSheetGridRunActions'
import { useEnrichColumnActions } from '@/hooks/sheet/useEnrichColumnActions'
import { useCleanColumnActions } from '@/hooks/sheet/useCleanColumnActions'
import { useFormulaColumnActions } from '@/hooks/sheet/useFormulaColumnActions'
import { useLookupColumnActions } from '@/hooks/sheet/useLookupColumnActions'
import type { CleanColumnView } from '@/utils/api/clean'
import type { FormulaColumnView } from '@/utils/api/formula'
import type { LookupColumnView } from '@/utils/api/lookup'
import type { FormulaOpenTarget } from '@/components/formula/useFormulaForm'
import type { LookupOpenTarget } from '@/components/lookup/useLookupForm'
import type { CleanOpenTarget } from '@/components/clean/useCleanForm'
import type {
  AGGridSpreadsheetProps, CellClickInfo, RunByColumn, RunMenuActions,
} from '@/components/aggrid/types'
import type { EnrichOpenTarget } from '@/components/enrich-modal/useOpenRequest'
import { EnrichRerunConfirm } from './EnrichRerunConfirm'
import { useColumnRunDialogs } from './ColumnRunDialogs'
import { AnswerPanel } from '@/components/answer-panel/AnswerPanel'
import { useAnswerPanel } from '@/hooks/sheet/useAnswerPanel'
import { opensAnswer, opensTrace } from '@/components/answer-panel/answer-click'
import { useWaterfallColumn } from '@/hooks/sheet/useWaterfallColumn'
import { WaterfallRerunConfirm } from '@/components/waterfall/WaterfallRerunConfirm'
import { TracePanel } from '@/components/waterfall/TracePanel'
import type { WaterfallOpenTarget } from '@/components/waterfall/WaterfallDrawer'

export interface SheetGridProps {
  activeSheet: Sheet | null
  forceUpdate: number
  columns: string[]
  rows: SheetData['data']['rows']
  totalRows: number
  emptyFilter: Record<string, 'empty' | 'not_empty'>
  columnFilters: ColumnFilters
  lastRenamedColumn: { from: string; to: string; at: number } | null
  columnTypes: Record<string, ColumnType>
  // Auto-run and spend per column (header ⚡, tooltip, menu items) and the menu's ⚡ action.
  autorun?: SheetAutorun
  columnSpend?: Record<string, ColumnSpend>
  onAutorunAction?: (column: string, action: 'open' | 'off') => void
  // Clean data columns' setups (header icon, menu) and the Add Column dialog opened on Clean data.
  cleanColumns?: Record<string, CleanColumnView>
  onOpenClean?: (target: CleanOpenTarget) => void
  // Formula columns' setups (header icon, menu) and the Add Column dialog opened on a formula.
  formulaColumns?: Record<string, FormulaColumnView>
  onOpenFormula?: (target: FormulaOpenTarget) => void
  // Lookup columns' setups (header icon, menu) and the Add Column dialog opened on a lookup.
  lookupColumns?: Record<string, LookupColumnView>
  onOpenLookup?: (target: LookupOpenTarget) => void
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
  onColumnFilterChange: (column: string, filter: ColumnFilter | null) => void
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
  // Opens the enrichment drawer on a column's setup or a run (Enrichment Actions).
  onOpenEnrichment?: (target: EnrichOpenTarget) => void
  // Opens the Waterfall drawer on a column's setup or a run (Waterfall Actions).
  onOpenWaterfall?: (target: WaterfallOpenTarget) => void
  // Save as setup, from a filled column's menu.
  onSaveSetup?: (column: string) => void
  // The view showing: its hidden columns, and "Hide column" in the column menu.
  hiddenColumns?: ReadonlySet<string>
  onHideColumn?: (column: string) => void
  // Column descriptions (the header's note) and the column menu's Edit description.
  columnDescriptions?: Record<string, string>
  onEditDescription?: (column: string) => void
  // The view has a filter no column header shows (the bar above lists it).
  rowFilterActive?: boolean
  // Search: the held rows' place in the view, the rows above a deep window,
  // the grid's "/", and its highlight handle (AGGridSpreadsheetProps).
  windowStart?: number
  onLoadEarlier?: (windowStart: number, firstRowIndex: number) => void
  onOpenSearch?: () => void
  registerSearch?: AGGridSpreadsheetProps['registerSearch']
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
    onOpenEnrichment, autorun, columnSpend, onAutorunAction, cleanColumns, onOpenClean, formulaColumns, onOpenFormula,
    onSaveSetup, hiddenColumns, onHideColumn, rowFilterActive, lookupColumns, onOpenLookup,
    columnDescriptions, onEditDescription, windowStart, onLoadEarlier, onOpenSearch, registerSearch,
    onOpenWaterfall,
  } = props

  const actions = useSheetGridRunActions({
    activeSheet, activeAIRunsList, activeHTTPRuns,
    setShowAddColumnModal, setupSSEConnection,
    fetchActiveHTTPRuns, fetchActiveAIRuns, reloadSheetData, rowGenerationRef,
  })
  const enrich = useEnrichColumnActions({
    activeSheet, activeHTTPRuns, setupSSEConnection, fetchActiveHTTPRuns, reloadSheetData, rowGenerationRef,
    onOpenEnrichment,
  })
  const waterfall = useWaterfallColumn({
    activeSheet, activeHTTPRuns, setupSSEConnection, fetchActiveHTTPRuns, reloadSheetData, rowGenerationRef,
    onOpenWaterfall,
  })
  const clean = useCleanColumnActions({ activeSheet, cleanColumns, reloadSheetData, onOpenClean })
  const formula = useFormulaColumnActions({ activeSheet, formulaColumns, reloadSheetData, onOpenFormula })
  const lookup = useLookupColumnActions({ activeSheet, lookupColumns, reloadSheetData, onOpenLookup })
  // A click on an enrichment or HTTP API cell opens its answer; "Rerun this
  // row" goes through the column menu's selected-rows run and its confirm.
  const answers = useAnswerPanel({
    activeSheet, reloadSheetData,
    rowGeneration: () => (activeSheet ? rowGenerationRef?.current.get(activeSheet.id) : undefined),
    onRerunRow: (column, row, generation) => enrich.onEnrichAction('selected', column, [row], generation, true),
  })
  const handleCellClick = (rowIndex: number, columnName: string, value?: unknown, info?: CellClickInfo) => {
    if (opensTrace(columnTypes[columnName], value)) {
      answers.cancelPending()
      waterfall.traceClicked({ column: columnName, row: rowIndex, displayRow: info?.displayRow ?? rowIndex + 1 },
        info?.clicks ?? 1)
      return
    }
    waterfall.cancelPendingTrace()
    if (opensAnswer(columnTypes[columnName], value)) {
      answers.clicked({ column: columnName, row: rowIndex, displayRow: info?.displayRow ?? rowIndex + 1 },
        info?.clicks ?? 1)
      return
    }
    answers.cancelPending()
    onCellClick(rowIndex, columnName, value)
  }

  // "Run All Rows" and "Run First Rows" ask first (ColumnRunDialogs).
  const runDialogs = useColumnRunDialogs(actions, totalRows)

  const runActions: RunMenuActions = {
    onRunHTTPForColumn: (column) => runDialogs.askRunAll({ kind: 'http', column }),
    onRunHTTPForMissingOrError: actions.handleRunHTTPMissingOrError,
    onRunHTTPForRows: actions.handleRunHTTPForRows,
    onRunAIForColumn: (column, columnName) => runDialogs.askRunAll({ kind: 'ai', column, columnName }),
    onRunAIMissingOrError: actions.handleRunAIMissingOrError,
    onRunFirstRows: (kind, column, columnName) => runDialogs.askFirstRows({ kind, column, columnName }),
    onEditAIColumn: actions.handleEditAIColumn,
    canEditAIColumn: (column) => !structuredAIColumns?.has(column),
    onStopRunForColumn: actions.handleStopRunForColumn,
    onEnrichAction: enrich.onEnrichAction,
    onWaterfallAction: waterfall.onWaterfallAction,
    onAutorunAction,
    onCleanAction: clean.onCleanAction,
    onFormulaAction: formula.onFormulaAction,
    onLookupAction: lookup.onLookupAction,
    onSaveSetup,
    onHideColumn,
    onEditDescription,
  }

  return (
    <div className="flex flex-col h-full">
      {runDialogs.dialogs}
      <EnrichRerunConfirm pending={enrich.pending} onConfirm={enrich.confirm} onCancel={enrich.cancel} />
      <AnswerPanel {...answers.panel} />
      <WaterfallRerunConfirm pending={waterfall.pending} onConfirm={waterfall.confirm} onCancel={waterfall.cancel} />
      <TracePanel {...waterfall.tracePanel} />
      <div className="flex-1 min-h-0">
        <AGGridSpreadsheet
          key={`${activeSheet?.id}_${forceUpdate}`}
          sheetId={activeSheet?.id}
          columns={columns}
          data={rows}
      totalRows={totalRows}
      onCellEdit={onCellEdit}
      onCellClick={handleCellClick}
      onLoadMore={onLoadMore}
      onSortChange={onSortChange}
      lastRenamedColumn={lastRenamedColumn}
      emptyFilter={emptyFilter}
      columnFilters={columnFilters}
      onEmptyFilterChange={onEmptyFilterChange}
      onColumnFilterChange={onColumnFilterChange}
      hiddenColumns={hiddenColumns} rowFilterActive={rowFilterActive}
      onSelectedRowsChange={onSelectedRowsChange}
      onRenameColumn={onRenameColumn}
      onDeleteColumn={(col) => actions.handleDeleteColumnWithWidthCleanup(col, onDeleteColumn)}
      onDeleteRows={onDeleteRows}
      runActions={runActions}
      columnTypes={columnTypes} autorun={autorun} columnSpend={columnSpend} cleanColumns={cleanColumns}
      formulaColumns={formulaColumns} lookupColumns={lookupColumns} columnDescriptions={columnDescriptions}
      activeHTTPRunsByColumn={activeHTTPRunsByColumn}
      activeAIRunsByColumn={activeAIRunsByColumn}
      onColumnReorder={onColumnReorder}
      onAddColumn={onAddColumn}
      registerClearSelection={registerClearSelection}
      registerViewport={registerViewport}
      windowStart={windowStart} onLoadEarlier={onLoadEarlier} onOpenSearch={onOpenSearch}
      registerSearch={registerSearch}
      className="w-full h-full"
    />
      </div>
      {/* The add-rows control moved to the consolidated bottom bar (SheetTabsBar) in
          SheetPage so it sits beside the sheet tabs and stays visible even on an empty
          sheet (which renders SheetEmptyState, not this grid). */}
    </div>
  )
}

import type { ColumnType } from '@/utils/api/types'
import type { ColumnSpend, SheetAutorun } from '@/utils/api/types-autorun'
import type { CleanColumnView } from '@/utils/api/clean'
import type { FormulaColumnView } from '@/utils/api/formula'

export type RunByColumn = Record<string, { runId: string; status: 'running' | 'paused' | 'pending' }>

// The column menu's Enrichment Actions: run the column again on rows by status
// (not enriched yet, failed), on the selected rows or on every row; edit its
// setup; watch or stop its active run.
export type EnrichMenuAction = 'not_enriched' | 'failed' | 'selected' | 'all' | 'edit' | 'view' | 'stop'

// The column menu's clean data items: clean any column into a new one ('new'),
// and on a clean column, edit how it's cleaned, clean every row again, and
// turn its auto-run on or off.
export type CleanMenuAction = 'new' | 'edit' | 'again' | 'autorun_on' | 'autorun_off'

// A formula column's items: edit its formula, work every row out again, and
// turn its auto-run on or off.
export type FormulaMenuAction = 'edit' | 'again' | 'autorun_on' | 'autorun_off'

export interface RunMenuActions {
  onRunHTTPForColumn?: (columnName: string) => void
  // Batched: re-run the whole row selection in ONE run (N per-row runs would
  // trip the per-user concurrency cap). See useHTTPColumnRunActions.
  onRunHTTPForRows?: (columnName: string, rowIndices: number[]) => void
  onRunHTTPForMissingOrError?: (columnName: string) => void
  onRunAIForColumn?: (baseName: string, columnName: string) => void
  onRunAIMissingOrError?: (baseName: string, columnName: string) => void
  onEditAIColumn?: (baseName: string) => void
  // False for a column of a structured (multi-column) run: the edit dialog only
  // knows single-column runs, so "Edit / Update Instructions" is hidden there.
  canEditAIColumn?: (columnName: string) => boolean
  onStopRunForColumn?: (type: 'http' | 'ai', columnName: string) => void
  onEnrichAction?: (action: EnrichMenuAction, columnName: string, rowIndices?: number[]) => void
  // ⚡ Turn On Auto-run / Auto-run Settings ('open', the dialog) and ⚡ Turn Off Auto-run.
  onAutorunAction?: (columnName: string, action: 'open' | 'off') => void
  onCleanAction?: (action: CleanMenuAction, columnName: string) => void
  onFormulaAction?: (action: FormulaMenuAction, columnName: string) => void
}

export interface AGGridSpreadsheetProps {
  columns: string[]
  // Authoritative per-column type from the server (run-record derived). Drives the
  // header menu's AI-vs-HTTP actions. Columns absent from the map are plain.
  columnTypes?: Record<string, ColumnType>
  // Auto-run and spend per column: the header's ⚡ and tooltip, and the menu's auto-run items.
  autorun?: SheetAutorun
  columnSpend?: Record<string, ColumnSpend>
  // Clean data columns' setups: the header's brush icon and its hover note.
  cleanColumns?: Record<string, CleanColumnView>
  // Formula columns' setups: the header's formula icon and its hover note.
  formulaColumns?: Record<string, FormulaColumnView>
  data: Array<{ rowIndex: number; data: Record<string, string> }>
  totalRows: number
  onCellEdit: (rowIndex: number, column: string, value: string) => void
  onLoadMore?: (offset: number, limit: number) => void
  className?: string
  // Triggers a one-time PHYSICAL sort (Google Sheets semantics) via the header
  // menu. The grid itself never sorts — rows always render in row_index order.
  onSortChange?: (column: string, direction?: 'asc' | 'desc' | null) => void
  // Returns whether the rename succeeded so the popover stays open on failure
  // (duplicate name, network error). void/undefined is treated as success.
  onRenameColumn?: (oldName: string, newName: string) => boolean | void | Promise<boolean | void>
  onDeleteColumn?: (columnName: string) => void | Promise<void>
  onDeleteRows?: (rowIndexes: number[]) => void | Promise<void>
  onAddColumn?: () => void | Promise<void>
  emptyFilter?: Record<string, 'empty' | 'not_empty'>
  onEmptyFilterChange?: (column: string, value: 'empty' | 'not_empty' | null) => void
  columnFilters?: Record<string, { type: 'contains'; value: string }>
  onColumnFilterChange?: (column: string, value: string | null) => void
  onSelectedRowsChange?: (rows: number[]) => void
  onCellClick?: (rowIndex: number, columnName: string, value?: unknown, info?: CellClickInfo) => void
  // What the column menu's run blocks call (AI, HTTP API and enrichment columns).
  runActions?: RunMenuActions
  activeHTTPRunsByColumn?: RunByColumn
  activeAIRunsByColumn?: RunByColumn
  onColumnReorder?: (newColumnOrder: string[]) => void | Promise<void>
  sheetId?: string
  // Signal that a column was renamed in place. Preserves AG Grid's internal colId
  // across the rename so the column stays in position. The `at` timestamp prevents
  // stale fires. The stable colId pattern is load-bearing (see useColIdMap.ts).
  lastRenamedColumn?: { from: string; to: string; at: number } | null
  // Registers an imperative "clear row selection" callback (deselectAll through
  // AG Grid) with the parent, so the topbar delete confirm — rendered outside the
  // grid — can deselect via the same source-of-truth path. Called with null on
  // unmount to unregister.
  registerClearSelection?: (clear: (() => void) | null) => void
  // Registers a getter for the first rendered row (useRegisterViewport), so a
  // background reload refreshes the rows in view. Null on unmount.
  registerViewport?: (get: (() => number | null) | null) => void
}

// A grid click: the row number the grid shows, and the click count (2 on a double click).
export interface CellClickInfo { displayRow: number; clicks: number }

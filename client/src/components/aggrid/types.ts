import type { ColumnType } from '@/utils/api/types'

export interface AGGridSpreadsheetProps {
  columns: string[]
  // Authoritative per-column type from the server (run-record derived). Drives the
  // header menu's AI-vs-HTTP actions. Columns absent from the map are plain.
  columnTypes?: Record<string, ColumnType>
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
  onCellClick?: (rowIndex: number, columnName: string) => void
  onRunHTTPForColumn?: (columnName: string) => void
  // Batched: re-run the whole row selection in ONE run (N per-row runs would
  // trip the per-user concurrency cap). See useSheetGridRunActions.handleRunHTTPForRows.
  onRunHTTPForRows?: (columnName: string, rowIndices: number[]) => void
  onRunHTTPForMissingOrError?: (columnName: string) => void
  onRunAIForColumn?: (baseName: string) => void
  onRunAIMissingOrError?: (baseName: string) => void
  onEditAIColumn?: (baseName: string) => void
  activeHTTPRunsByColumn?: Record<string, { runId: string; status: 'running' | 'paused' | 'pending' }>
  activeAIRunsByColumn?: Record<string, { runId: string; status: 'running' | 'paused' | 'pending' }>
  onStopRunForColumn?: (type: 'http' | 'ai', columnName: string) => void
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
}

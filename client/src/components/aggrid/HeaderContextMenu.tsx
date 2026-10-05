import React from 'react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ColumnType } from '@/utils/api/types'
import { ContainsFilterInput } from './ContainsFilterInput'

export type MenuState = {
  x: number; y: number; columnId: string; selectedRowIndices?: number[]
} | null

interface AIActionsProps {
  columnId: string
  columnType?: ColumnType
  activeAIRunsByColumn: Record<string, { runId: string; status: 'running' | 'paused' | 'pending' }>
  setMenu: (m: MenuState) => void
  onRunAIForColumn?: (baseName: string, columnName: string) => void
  onRunAIMissingOrError?: (baseName: string, columnName: string) => void
  onEditAIColumn?: (columnName: string) => void
  onStopRunForColumn?: (type: 'http' | 'ai', columnName: string) => void
}

const AIColumnActions: React.FC<AIActionsProps> = ({
  columnId, columnType, activeAIRunsByColumn, setMenu,
  onRunAIForColumn, onRunAIMissingOrError, onEditAIColumn, onStopRunForColumn,
}) => {
  // AUTHORITATIVE: only render AI actions when the server classifies this column
  // as AI-owned. The base name (the AI run's column_name minus its " (Output)"/
  // " (Data)" suffix) still comes from the name — but only after the type confirms
  // it's an AI column, so a plain column literally named "X (Data)" is never matched.
  if (columnType !== 'ai-output' && columnType !== 'ai-data') return null
  const base = columnId.replace(/ \((Output|Data)\)$/, '')
  // The active run writing this column: listed under the column itself (a
  // single-column run's "(Output)", or any column of a structured run), or, for
  // a "(Data)" column, under its "(Output)".
  const runColumn = activeAIRunsByColumn[columnId] ? columnId
    : activeAIRunsByColumn[`${base} (Output)`] ? `${base} (Output)` : null
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>AI Column Actions</DropdownMenuLabel>
      {onRunAIForColumn && (
        <DropdownMenuItem onClick={() => { onRunAIForColumn(base, columnId); setMenu(null) }} className="text-gray-700 focus:text-gray-900">🔄 Run All Rows</DropdownMenuItem>
      )}
      {onRunAIMissingOrError && (
        <DropdownMenuItem onClick={() => { onRunAIMissingOrError(base, columnId); setMenu(null) }} className="text-gray-700 focus:text-gray-900">🔁 Run Missing or Errors</DropdownMenuItem>
      )}
      {onEditAIColumn && (
        <DropdownMenuItem onClick={() => { onEditAIColumn(base); setMenu(null) }}>✏️ Edit / Update Instructions</DropdownMenuItem>
      )}
      {runColumn && (
        <DropdownMenuItem onClick={() => { onStopRunForColumn?.('ai', runColumn); setMenu(null) }} className="text-red-600 focus:text-red-600">🟥 Stop AI Run</DropdownMenuItem>
      )}
    </>
  )
}

export interface HeaderContextMenuProps {
  menu: MenuState
  setMenu: (m: MenuState) => void
  setRenaming: (r: { x: number; y: number; oldName: string; value: string }) => void
  // Authoritative per-column type (server, run-record derived). Absent → plain.
  columnTypes: Record<string, ColumnType>
  emptyFilter?: Record<string, 'empty' | 'not_empty'>
  columnFilters?: Record<string, { type: 'contains'; value: string }>
  setConfirmDeleteColumn: (col: string | null) => void
  setConfirmDeleteRows: (rows: number[] | null) => void
  activeHTTPRunsByColumn: Record<string, { runId: string; status: 'running' | 'paused' | 'pending' }>
  activeAIRunsByColumn: Record<string, { runId: string; status: 'running' | 'paused' | 'pending' }>
  onSortChange?: (column: string, direction?: 'asc' | 'desc' | null) => void
  onEmptyFilterChange?: (column: string, value: 'empty' | 'not_empty' | null) => void
  onColumnFilterChange?: (column: string, value: string | null) => void
  onDeleteColumn?: (columnName: string) => void | Promise<void>
  onDeleteRows?: (rowIndexes: number[]) => void | Promise<void>
  onRunHTTPForColumn?: (columnName: string) => void
  onRunHTTPForRows?: (columnName: string, rowIndices: number[]) => void
  onRunHTTPForMissingOrError?: (columnName: string) => void
  onRunAIForColumn?: (baseName: string, columnName: string) => void
  onRunAIMissingOrError?: (baseName: string, columnName: string) => void
  onEditAIColumn?: (baseName: string) => void
  onStopRunForColumn?: (type: 'http' | 'ai', columnName: string) => void
}

export const HeaderContextMenu: React.FC<HeaderContextMenuProps> = (props) => {
  const {
    menu, setMenu, setRenaming, columnTypes, emptyFilter, columnFilters,
    setConfirmDeleteColumn, setConfirmDeleteRows,
    activeHTTPRunsByColumn, activeAIRunsByColumn,
    onSortChange, onEmptyFilterChange, onColumnFilterChange, onDeleteColumn, onDeleteRows,
    onRunHTTPForColumn, onRunHTTPForRows, onRunHTTPForMissingOrError,
    onRunAIForColumn, onRunAIMissingOrError, onEditAIColumn, onStopRunForColumn,
  } = props

  if (!menu) return null

  // One type per column → AI and HTTP action blocks are mutually exclusive (the
  // old heuristics could match both at once and stack both menus).
  const columnType = columnTypes[menu.columnId]
  const isHTTPMaster = columnType === 'http-master'

  return (
    <DropdownMenu open={!!menu} onOpenChange={(open) => !open && setMenu(null)}>
      <DropdownMenuTrigger asChild>
        <div style={{ position: 'absolute', top: menu.y, left: menu.x, zIndex: 50 }} className="w-0 h-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="start" side="bottom" alignOffset={0} sideOffset={4}>
        <DropdownMenuItem onClick={() => {
          setRenaming({ x: menu.x, y: menu.y, oldName: menu.columnId, value: menu.columnId })
          setMenu(null)
        }}>Rename column</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => { onSortChange?.(menu.columnId, 'asc'); setMenu(null) }}>Sort ascending</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { onSortChange?.(menu.columnId, 'desc'); setMenu(null) }}>Sort descending</DropdownMenuItem>

        {isHTTPMaster && onRunHTTPForColumn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>HTTP API Actions</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => { onRunHTTPForColumn(menu.columnId); setMenu(null) }} className="text-gray-700 focus:text-gray-900">🔄 Run All Rows</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { onRunHTTPForMissingOrError?.(menu.columnId); setMenu(null) }} className="text-gray-700 focus:text-gray-900">🔁 Run Missing or Errors</DropdownMenuItem>
            {menu.selectedRowIndices && menu.selectedRowIndices.length > 0 && (
              <DropdownMenuItem
                onClick={() => {
                  // One batched run for the whole selection — not one run per row.
                  if (menu.selectedRowIndices?.length) onRunHTTPForRows?.(menu.columnId, menu.selectedRowIndices)
                  setMenu(null)
                }}
                className="text-gray-700 focus:text-gray-900"
              >
                🔄 Run Selected Rows ({menu.selectedRowIndices.length})
              </DropdownMenuItem>
            )}
            {activeHTTPRunsByColumn[menu.columnId] && (
              <DropdownMenuItem onClick={() => { onStopRunForColumn?.('http', menu.columnId); setMenu(null) }} className="text-red-600 focus:text-red-600">
                🟥 Stop HTTP Run
              </DropdownMenuItem>
            )}
          </>
        )}

        <AIColumnActions
          columnId={menu.columnId}
          columnType={columnType}
          activeAIRunsByColumn={activeAIRunsByColumn}
          setMenu={setMenu}
          onRunAIForColumn={onRunAIForColumn}
          onRunAIMissingOrError={onRunAIMissingOrError}
          onEditAIColumn={onEditAIColumn}
          onStopRunForColumn={onStopRunForColumn}
        />

        {onColumnFilterChange && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Filter by text</DropdownMenuLabel>
            <ContainsFilterInput
              columnId={menu.columnId}
              current={columnFilters?.[menu.columnId]?.value ?? ''}
              onApply={(v) => onColumnFilterChange(menu.columnId, v)}
              hasEmptyFilter={!!emptyFilter?.[menu.columnId]}
              onClearEmpty={() => onEmptyFilterChange?.(menu.columnId, null)}
            />
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Filter by emptiness</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => { onColumnFilterChange?.(menu.columnId, null); onEmptyFilterChange?.(menu.columnId, 'empty'); setMenu(null) }}
          className={emptyFilter?.[menu.columnId] === 'empty' ? 'font-semibold' : ''}
        >Show empty only</DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => { onColumnFilterChange?.(menu.columnId, null); onEmptyFilterChange?.(menu.columnId, 'not_empty'); setMenu(null) }}
          className={emptyFilter?.[menu.columnId] === 'not_empty' ? 'font-semibold' : ''}
        >Show non-empty only</DropdownMenuItem>
        {emptyFilter?.[menu.columnId] && (
          <DropdownMenuItem onClick={() => { onEmptyFilterChange?.(menu.columnId, null); setMenu(null) }}>Clear filter</DropdownMenuItem>
        )}

        {onDeleteColumn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => { setConfirmDeleteColumn(menu.columnId); setMenu(null) }}
              className="text-red-600 focus:text-red-600"
            >Delete column</DropdownMenuItem>
          </>
        )}

        {onDeleteRows && (menu.selectedRowIndices?.length || 0) > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => { setConfirmDeleteRows(menu.selectedRowIndices || []); setMenu(null) }}
              className="text-red-600 focus:text-red-600"
            >Delete selected rows ({menu.selectedRowIndices?.length || 0})</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

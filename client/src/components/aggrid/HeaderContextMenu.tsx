import React from 'react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ColumnType } from '@/utils/api/types'
import type { AutorunColumn } from '@/utils/api/types-autorun'
import type { ColumnFilter, ColumnFilters } from '@/lib/filters'
import { ColumnFilterMenu } from './ColumnFilterMenu'
import { AIColumnActions, HTTPColumnActions } from './ColumnRunActions'
import { EnrichColumnActions } from './EnrichColumnActions'
import { CleanColumnActions } from './CleanColumnActions'
import { FormulaColumnActions } from './FormulaColumnActions'
import { LookupColumnActions } from './LookupColumnActions'
import type { RunByColumn, RunMenuActions } from './types'

// Columns a setup can hold: filled ones (lib/setups on the server says which can't, and why).
const SAVABLE = new Set<ColumnType | undefined>([
  'ai-output', 'ai-data', 'http-master', 'enrich-status', 'http-extracted', 'clean', 'formula',
])

export type MenuState = {
  x: number; y: number; columnId: string; selectedRowIndices?: number[]
} | null

export interface HeaderContextMenuProps {
  menu: MenuState
  setMenu: (m: MenuState) => void
  setRenaming: (r: { x: number; y: number; oldName: string; value: string }) => void
  // Authoritative per-column type (server, run-record derived). Absent → plain.
  columnTypes: Record<string, ColumnType>
  // Auto-run per status column: the run blocks' ⚡ items.
  autorunColumns?: Record<string, AutorunColumn>
  emptyFilter?: Record<string, 'empty' | 'not_empty'>
  columnFilters?: ColumnFilters
  setConfirmDeleteColumn: (col: string | null) => void
  setConfirmDeleteRows: (rows: number[] | null) => void
  activeHTTPRunsByColumn: RunByColumn
  activeAIRunsByColumn: RunByColumn
  onSortChange?: (column: string, direction?: 'asc' | 'desc' | null) => void
  onEmptyFilterChange?: (column: string, value: 'empty' | 'not_empty' | null) => void
  onColumnFilterChange?: (column: string, filter: ColumnFilter | null) => void
  onDeleteColumn?: (columnName: string) => void | Promise<void>
  onDeleteRows?: (rowIndexes: number[]) => void | Promise<void>
  runActions: RunMenuActions
  // The value picker of "is any of" counts this sheet's values.
  sheetId?: string
}

export const HeaderContextMenu: React.FC<HeaderContextMenuProps> = (props) => {
  const {
    menu, setMenu, setRenaming, columnTypes, autorunColumns, emptyFilter, columnFilters,
    setConfirmDeleteColumn, setConfirmDeleteRows, activeHTTPRunsByColumn, activeAIRunsByColumn,
    onSortChange, onEmptyFilterChange, onColumnFilterChange, onDeleteColumn, onDeleteRows, runActions, sheetId,
  } = props

  if (!menu) return null

  // One type per column → the AI, HTTP and enrichment blocks are mutually
  // exclusive (the old heuristics could match both at once and stack both menus).
  const columnType = columnTypes[menu.columnId]
  const runProps = {
    columnId: menu.columnId, setMenu, actions: runActions, autorun: autorunColumns?.[menu.columnId],
  }

  return (
    <DropdownMenu open={!!menu} onOpenChange={(open) => !open && setMenu(null)}>
      <DropdownMenuTrigger asChild>
        <div style={{ position: 'absolute', top: menu.y, left: menu.x, zIndex: 50 }} className="w-0 h-0" />
      </DropdownMenuTrigger>
      {/* Scrolls inside the room below the header: a run column's menu is taller than a short window. */}
      <DropdownMenuContent align="start" side="bottom" alignOffset={0} sideOffset={4}
        className="w-56 !overflow-y-auto max-h-[var(--radix-dropdown-menu-content-available-height)]">
        <DropdownMenuItem onClick={() => {
          setRenaming({ x: menu.x, y: menu.y, oldName: menu.columnId, value: menu.columnId })
          setMenu(null)
        }}>Rename column</DropdownMenuItem>
        {runActions.onEditDescription && (
          <DropdownMenuItem data-testid="edit-description"
            onClick={() => { runActions.onEditDescription!(menu.columnId); setMenu(null) }}>
            Edit description…
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => { onSortChange?.(menu.columnId, 'asc'); setMenu(null) }}>
          Sort ascending
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => { onSortChange?.(menu.columnId, 'desc'); setMenu(null) }}>
          Sort descending
        </DropdownMenuItem>
        {runActions.onHideColumn && (
          <DropdownMenuItem onClick={() => { runActions.onHideColumn!(menu.columnId); setMenu(null) }}>
            Hide column
          </DropdownMenuItem>
        )}
        <CleanColumnActions {...runProps} isClean={columnType === 'clean'} />
        {columnType === 'formula' && <FormulaColumnActions {...runProps} />}
        {columnType === 'lookup' && <LookupColumnActions {...runProps} />}

        {columnType === 'http-master' && (
          <HTTPColumnActions {...runProps} selectedRowIndices={menu.selectedRowIndices}
            activeHTTPRunsByColumn={activeHTTPRunsByColumn} />
        )}
        {(columnType === 'enrich-status' || columnType === 'waterfall') && (
          <EnrichColumnActions {...runProps} selectedRowIndices={menu.selectedRowIndices}
            activeHTTPRunsByColumn={activeHTTPRunsByColumn} waterfall={columnType === 'waterfall'} />
        )}
        <AIColumnActions {...runProps} columnType={columnType} activeAIRunsByColumn={activeAIRunsByColumn} />
        {runActions.onSaveSetup && SAVABLE.has(columnType) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { runActions.onSaveSetup!(menu.columnId); setMenu(null) }}
              className="text-gray-700 focus:text-gray-900">💾 Save as setup…</DropdownMenuItem>
          </>
        )}

        <ColumnFilterMenu columnId={menu.columnId} sheetId={sheetId} columnType={columnType} setMenu={setMenu}
          emptyFilter={emptyFilter?.[menu.columnId]} columnFilter={columnFilters?.[menu.columnId]}
          onEmptyFilterChange={onEmptyFilterChange} onColumnFilterChange={onColumnFilterChange} />

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

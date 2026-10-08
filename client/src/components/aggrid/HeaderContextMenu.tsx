import React from 'react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ColumnType } from '@/utils/api/types'
import { ContainsFilterInput } from './ContainsFilterInput'
import { AIColumnActions, HTTPColumnActions } from './ColumnRunActions'
import { EnrichColumnActions } from './EnrichColumnActions'
import type { RunByColumn, RunMenuActions } from './types'

export type MenuState = {
  x: number; y: number; columnId: string; selectedRowIndices?: number[]
} | null

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
  activeHTTPRunsByColumn: RunByColumn
  activeAIRunsByColumn: RunByColumn
  onSortChange?: (column: string, direction?: 'asc' | 'desc' | null) => void
  onEmptyFilterChange?: (column: string, value: 'empty' | 'not_empty' | null) => void
  onColumnFilterChange?: (column: string, value: string | null) => void
  onDeleteColumn?: (columnName: string) => void | Promise<void>
  onDeleteRows?: (rowIndexes: number[]) => void | Promise<void>
  runActions: RunMenuActions
}

export const HeaderContextMenu: React.FC<HeaderContextMenuProps> = (props) => {
  const {
    menu, setMenu, setRenaming, columnTypes, emptyFilter, columnFilters,
    setConfirmDeleteColumn, setConfirmDeleteRows, activeHTTPRunsByColumn, activeAIRunsByColumn,
    onSortChange, onEmptyFilterChange, onColumnFilterChange, onDeleteColumn, onDeleteRows, runActions,
  } = props

  if (!menu) return null

  // One type per column → the AI, HTTP and enrichment blocks are mutually
  // exclusive (the old heuristics could match both at once and stack both menus).
  const columnType = columnTypes[menu.columnId]
  const runProps = { columnId: menu.columnId, setMenu, actions: runActions }
  // An emptiness filter replaces the column's text filter.
  const emptiness = (value: 'empty' | 'not_empty') => {
    onColumnFilterChange?.(menu.columnId, null)
    onEmptyFilterChange?.(menu.columnId, value)
    setMenu(null)
  }

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
        <DropdownMenuItem onClick={() => { onSortChange?.(menu.columnId, 'asc'); setMenu(null) }}>
          Sort ascending
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => { onSortChange?.(menu.columnId, 'desc'); setMenu(null) }}>
          Sort descending
        </DropdownMenuItem>

        {columnType === 'http-master' && (
          <HTTPColumnActions {...runProps} selectedRowIndices={menu.selectedRowIndices}
            activeHTTPRunsByColumn={activeHTTPRunsByColumn} />
        )}
        {columnType === 'enrich-status' && (
          <EnrichColumnActions {...runProps} selectedRowIndices={menu.selectedRowIndices}
            activeHTTPRunsByColumn={activeHTTPRunsByColumn} />
        )}
        <AIColumnActions {...runProps} columnType={columnType} activeAIRunsByColumn={activeAIRunsByColumn} />

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
        <DropdownMenuItem onClick={() => emptiness('empty')}
          className={emptyFilter?.[menu.columnId] === 'empty' ? 'font-semibold' : ''}
        >Show empty only</DropdownMenuItem>
        <DropdownMenuItem onClick={() => emptiness('not_empty')}
          className={emptyFilter?.[menu.columnId] === 'not_empty' ? 'font-semibold' : ''}
        >Show non-empty only</DropdownMenuItem>
        {emptyFilter?.[menu.columnId] && (
          <DropdownMenuItem onClick={() => { onEmptyFilterChange?.(menu.columnId, null); setMenu(null) }}>
            Clear filter
          </DropdownMenuItem>
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

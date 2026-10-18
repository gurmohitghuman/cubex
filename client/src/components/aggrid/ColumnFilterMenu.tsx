import React from 'react'
import {
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import type { ColumnType } from '@/utils/api/types'
import { RUN_STATE_FILTERS, isRunColumn, isRunStateFilter, type ColumnFilter, type RunStateOp } from '@/lib/filters'
import { ColumnFilterEditor } from './ColumnFilterEditor'
import type { MenuState } from './HeaderContextMenu'

// The column menu's Filter section. One filter per column: a run-state filter
// (on a column an AI, HTTP API or enrichment run fills, read from the words
// the run writes), a value filter, or empty / non-empty. Picking one replaces
// the column's other one. "Rows with errors" is one click; the other run
// states sit under "Run state".
export const ColumnFilterMenu: React.FC<{
  columnId: string
  sheetId?: string
  columnType?: ColumnType
  emptyFilter?: 'empty' | 'not_empty'
  columnFilter?: ColumnFilter
  setMenu: (m: MenuState) => void
  onEmptyFilterChange?: (column: string, value: 'empty' | 'not_empty' | null) => void
  onColumnFilterChange?: (column: string, filter: ColumnFilter | null) => void
}> = (props) => {
  const {
    columnId, sheetId, columnType, emptyFilter, columnFilter, setMenu, onEmptyFilterChange, onColumnFilterChange,
  } = props
  const state = columnFilter && isRunStateFilter(columnFilter.type) ? columnFilter.type : null
  const pickState = (op: RunStateOp) => {
    if (emptyFilter) onEmptyFilterChange?.(columnId, null)
    if (state !== op) onColumnFilterChange?.(columnId, { type: op })
    setMenu(null)
  }
  const emptiness = (value: 'empty' | 'not_empty') => {
    if (columnFilter) onColumnFilterChange?.(columnId, null)
    onEmptyFilterChange?.(columnId, value)
    setMenu(null)
  }
  const clear = () => {
    if (columnFilter) onColumnFilterChange?.(columnId, null)
    if (emptyFilter) onEmptyFilterChange?.(columnId, null)
    setMenu(null)
  }
  const mark = (on: boolean) => (on ? 'font-semibold' : '')
  const [errors, ...others] = RUN_STATE_FILTERS

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Filter</DropdownMenuLabel>
      {onColumnFilterChange && isRunColumn(columnType) && (
        <>
          <DropdownMenuItem onClick={() => pickState(errors.op)} className={mark(state === errors.op)}>
            ⚠️ {errors.label}{state === errors.op ? ' ✓' : ''}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={mark(!!state && state !== errors.op)}>Run state</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-56">
                {others.map(f => (
                  <DropdownMenuItem key={f.op} onClick={() => pickState(f.op)} className={mark(state === f.op)}>
                    {f.label}{state === f.op ? ' ✓' : ''}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </>
      )}
      {onColumnFilterChange && (
        <ColumnFilterEditor
          columnId={columnId} sheetId={sheetId}
          current={columnFilter}
          onApply={f => onColumnFilterChange(columnId, f)}
          hasEmptyFilter={!!emptyFilter}
          onClearEmpty={() => onEmptyFilterChange?.(columnId, null)}
        />
      )}
      <DropdownMenuItem onClick={() => emptiness('empty')} className={mark(emptyFilter === 'empty')}>
        Show empty only
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => emptiness('not_empty')} className={mark(emptyFilter === 'not_empty')}>
        Show non-empty only
      </DropdownMenuItem>
      {(emptyFilter || columnFilter) && <DropdownMenuItem onClick={clear}>Clear filter</DropdownMenuItem>}
    </>
  )
}

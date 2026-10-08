import React from 'react'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { ColumnType } from '@/utils/api/types'
import type { MenuState } from './HeaderContextMenu'
import type { RunByColumn, RunMenuActions } from './types'

// The column menu's run blocks for AI and HTTP API columns, split out of
// HeaderContextMenu (each column type gets its own block; enrichment columns
// have theirs in EnrichColumnActions).

const ITEM = 'text-gray-700 focus:text-gray-900'
const STOP = 'text-red-600 focus:text-red-600'

interface AIActionsProps {
  columnId: string
  columnType?: ColumnType
  activeAIRunsByColumn: RunByColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
}

export const AIColumnActions: React.FC<AIActionsProps> = ({
  columnId, columnType, activeAIRunsByColumn, setMenu, actions,
}) => {
  // AUTHORITATIVE: only render AI actions when the server classifies this column
  // as AI-owned. The base name (the AI run's column_name minus its " (Output)"/
  // " (Data)" suffix) still comes from the name — but only after the type confirms
  // it's an AI column, so a plain column literally named "X (Data)" is never matched.
  if (columnType !== 'ai-output' && columnType !== 'ai-data') return null
  const { onRunAIForColumn, onRunAIMissingOrError, onEditAIColumn, onStopRunForColumn } = actions
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
        <DropdownMenuItem onClick={() => { onRunAIForColumn(base, columnId); setMenu(null) }} className={ITEM}>
          🔄 Run All Rows
        </DropdownMenuItem>
      )}
      {onRunAIMissingOrError && (
        <DropdownMenuItem onClick={() => { onRunAIMissingOrError(base, columnId); setMenu(null) }} className={ITEM}>
          🔁 Run Missing or Errors
        </DropdownMenuItem>
      )}
      {onEditAIColumn && (
        <DropdownMenuItem onClick={() => { onEditAIColumn(base); setMenu(null) }}>
          ✏️ Edit / Update Instructions
        </DropdownMenuItem>
      )}
      {runColumn && (
        <DropdownMenuItem onClick={() => { onStopRunForColumn?.('ai', runColumn); setMenu(null) }} className={STOP}>
          🟥 Stop AI Run
        </DropdownMenuItem>
      )}
    </>
  )
}

interface HTTPActionsProps {
  columnId: string
  selectedRowIndices?: number[]
  activeHTTPRunsByColumn: RunByColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
}

export const HTTPColumnActions: React.FC<HTTPActionsProps> = ({
  columnId, selectedRowIndices, activeHTTPRunsByColumn, setMenu, actions,
}) => {
  const { onRunHTTPForColumn, onRunHTTPForMissingOrError, onRunHTTPForRows, onStopRunForColumn } = actions
  if (!onRunHTTPForColumn) return null
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>HTTP API Actions</DropdownMenuLabel>
      <DropdownMenuItem onClick={() => { onRunHTTPForColumn(columnId); setMenu(null) }} className={ITEM}>
        🔄 Run All Rows
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => { onRunHTTPForMissingOrError?.(columnId); setMenu(null) }} className={ITEM}>
        🔁 Run Missing or Errors
      </DropdownMenuItem>
      {selectedRowIndices && selectedRowIndices.length > 0 && (
        <DropdownMenuItem
          onClick={() => {
            // One batched run for the whole selection — not one run per row.
            onRunHTTPForRows?.(columnId, selectedRowIndices)
            setMenu(null)
          }}
          className={ITEM}
        >
          🔄 Run Selected Rows ({selectedRowIndices.length})
        </DropdownMenuItem>
      )}
      {activeHTTPRunsByColumn[columnId] && (
        <DropdownMenuItem onClick={() => { onStopRunForColumn?.('http', columnId); setMenu(null) }} className={STOP}>
          🟥 Stop HTTP Run
        </DropdownMenuItem>
      )}
    </>
  )
}

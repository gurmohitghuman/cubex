import React from 'react'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { ColumnType } from '@/utils/api/types'
import type { MenuState } from './HeaderContextMenu'
import type { RunByColumn, RunMenuActions } from './types'
import type { AutorunColumn } from '@/utils/api/types-autorun'
import { AutorunMenuItems } from './AutorunMenuItems'
import { UndoRunItem } from './UndoRunItem'
import { rowsFor, useRunColumnCounts } from './useRunColumnCounts'
import { runItemLabel } from '@/lib/run-controls-copy'
import type { RunCounts } from '@/utils/api/run-controls'

// The column menu's run blocks for AI and HTTP API columns, split out of
// HeaderContextMenu (each column type gets its own block; enrichment columns
// have theirs in EnrichColumnActions). Their runs carry the column's numbers
// once counted, and each asks first with its estimate (useColumnRunControls).

const ITEM = 'text-gray-700 focus:text-gray-900'
const STOP = 'text-red-600 focus:text-red-600'

// "Run N empty or out-of-date rows", "Retry N failed rows" and "Force run all N rows": each in its
// place while counting, disabled once counted at 0 (no item moves under the pointer).
const RunControlItems: React.FC<{
  columnId: string; counts: RunCounts | null; setMenu: (m: MenuState) => void; actions: RunMenuActions
}> = ({ columnId, counts, setMenu, actions }) => {
  const run = actions.onRunControl
  if (!run) return null
  const item = (rows: 'empty_or_out_of_date' | 'failed' | 'all', icon: string, testId: string) => (
    <DropdownMenuItem onClick={() => { run(columnId, rows); setMenu(null) }} className={ITEM} data-testid={testId}
      disabled={rowsFor(counts, rows) === 0}>
      {icon} {runItemLabel(rows, counts)}
    </DropdownMenuItem>
  )
  return (
    <>
      {item('empty_or_out_of_date', '▶️', 'run-stale')}
      {item('failed', '🔁', 'run-failed')}
      {item('all', '⏩', 'run-all')}
    </>
  )
}

interface AIActionsProps {
  columnId: string
  columnType?: ColumnType
  activeAIRunsByColumn: RunByColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
  sheetId?: string
}

export const AIColumnActions: React.FC<AIActionsProps> = (props) => {
  // Only AI columns read their numbers (the block renders for every column type), and not while their run goes.
  const isAI = props.columnType === 'ai-output' || props.columnType === 'ai-data'
  const base = props.columnId.replace(/ \((Output|Data)\)$/, '')
  const running = !!props.activeAIRunsByColumn[props.columnId] || !!props.activeAIRunsByColumn[`${base} (Output)`]
  const counts = useRunColumnCounts(isAI && !running ? props.sheetId : undefined, props.columnId)
  return isAI ? <AIActions {...props} counts={counts} /> : null
}

const AIActions: React.FC<AIActionsProps & { counts: RunCounts | null }> = ({
  columnId, columnType, activeAIRunsByColumn, setMenu, actions, counts,
}) => {
  // AUTHORITATIVE: only render AI actions when the server classifies this column
  // as AI-owned. The base name (the AI run's column_name minus its " (Output)"/
  // " (Data)" suffix) still comes from the name — but only after the type confirms
  // it's an AI column, so a plain column literally named "X (Data)" is never matched.
  if (columnType !== 'ai-output' && columnType !== 'ai-data') return null
  const { onEditAIColumn, onStopRunForColumn } = actions
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
      {!runColumn && <RunControlItems columnId={columnId} counts={counts} setMenu={setMenu} actions={actions} />}
      {!runColumn && <UndoRunItem columnId={columnId} setMenu={setMenu} actions={actions} />}
      {actions.onRunFirstRows && (
        <DropdownMenuItem onClick={() => { actions.onRunFirstRows?.('ai', base, columnId); setMenu(null) }}
          className={ITEM}>
          🧪 Run First Rows…
        </DropdownMenuItem>
      )}
      {onEditAIColumn && (actions.canEditAIColumn?.(columnId) ?? true) && (
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
  autorun?: AutorunColumn
  sheetId?: string
}

export const HTTPColumnActions: React.FC<HTTPActionsProps> = ({
  columnId, selectedRowIndices, activeHTTPRunsByColumn, setMenu, actions, autorun, sheetId,
}) => {
  const { onRunHTTPForRows, onStopRunForColumn } = actions
  const active = !!activeHTTPRunsByColumn[columnId]
  const counts = useRunColumnCounts(active ? undefined : sheetId, columnId)
  if (!actions.onRunControl) return null
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>HTTP API Actions</DropdownMenuLabel>
      {!active && <RunControlItems columnId={columnId} counts={counts} setMenu={setMenu} actions={actions} />}
      {!active && <UndoRunItem columnId={columnId} setMenu={setMenu} actions={actions} />}
      {actions.onRunFirstRows && (
        <DropdownMenuItem onClick={() => { actions.onRunFirstRows?.('http', columnId); setMenu(null) }}
          className={ITEM}>
          🧪 Run First Rows…
        </DropdownMenuItem>
      )}
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
      <AutorunMenuItems columnId={columnId} autorun={autorun} setMenu={setMenu} actions={actions} />
      {active && (
        <DropdownMenuItem onClick={() => { onStopRunForColumn?.('http', columnId); setMenu(null) }} className={STOP}>
          🟥 Stop HTTP Run
        </DropdownMenuItem>
      )}
    </>
  )
}

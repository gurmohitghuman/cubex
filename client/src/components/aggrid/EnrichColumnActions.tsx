import React from 'react'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { MenuState } from './HeaderContextMenu'
import type { EnrichMenuAction, RunByColumn, RunMenuActions } from './types'
import type { AutorunColumn } from '@/utils/api/types-autorun'
import { AutorunMenuItems } from './AutorunMenuItems'
import { UndoRunItem } from './UndoRunItem'
import { rowsFor, useRunColumnCounts } from './useRunColumnCounts'
import { runItemLabel } from '@/lib/run-controls-copy'

interface Props {
  columnId: string
  selectedRowIndices?: number[]
  activeHTTPRunsByColumn: RunByColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
  autorun?: AutorunColumn
  // A waterfall's result column gets the same items (its runs go through the waterfall).
  waterfall?: boolean
  sheetId?: string
}

const ITEM = 'text-gray-700 focus:text-gray-900'

// "Enrichment Actions" on an enrichment's status column. Every run here goes
// through the enrichment start (with a confirm that quotes the estimate), not
// the plain HTTP rerun, which refuses enrichment columns. While a run on the
// column is active, only watching and stopping it are offered: a second run
// on the same column is refused until it ends. The items carry the column's
// numbers once counted: empty or out of date, failed, all.
export const EnrichColumnActions: React.FC<Props> = ({
  columnId, selectedRowIndices, activeHTTPRunsByColumn, setMenu, actions, autorun, waterfall, sheetId,
}) => {
  const active = !!activeHTTPRunsByColumn[columnId]
  const counts = useRunColumnCounts(active ? undefined : sheetId, columnId)
  const onEnrichAction = waterfall ? actions.onWaterfallAction : actions.onEnrichAction
  if (!onEnrichAction) return null
  const noun = waterfall ? 'Waterfall' : 'Enrichment'
  const act = (action: EnrichMenuAction, rows?: number[]) => () => {
    onEnrichAction(action, columnId, rows)
    setMenu(null)
  }
  const selected = selectedRowIndices ?? []
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{noun} Actions</DropdownMenuLabel>
      {!active && (
        <>
          <DropdownMenuItem onClick={act('stale')} className={ITEM} data-testid="run-stale"
            disabled={rowsFor(counts, 'empty_or_out_of_date') === 0}>
            ▶️ {runItemLabel('empty_or_out_of_date', counts)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={act('failed')} className={ITEM} data-testid="run-failed"
            disabled={rowsFor(counts, 'failed') === 0}>
            🔁 {runItemLabel('failed', counts)}
          </DropdownMenuItem>
          {selected.length > 0 && (
            <DropdownMenuItem onClick={act('selected', selected)} className={ITEM}>
              🔄 Run Selected Rows ({selected.length.toLocaleString()})
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={act('all')} className={ITEM} data-testid="run-all"
            disabled={rowsFor(counts, 'all') === 0}>
            ⏩ {runItemLabel('all', counts)}
          </DropdownMenuItem>
          <UndoRunItem columnId={columnId} setMenu={setMenu} actions={actions} />
        </>
      )}
      <DropdownMenuItem onClick={act('edit')} className={ITEM}>✏️ Edit {noun}</DropdownMenuItem>
      <AutorunMenuItems columnId={columnId} autorun={autorun} setMenu={setMenu} actions={actions} />
      {active && (
        <>
          <DropdownMenuItem onClick={act('view')} className={ITEM}>📈 View Run</DropdownMenuItem>
          <DropdownMenuItem onClick={act('stop')} className="text-red-600 focus:text-red-600">
            🟥 Stop {noun} Run
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

import React from 'react'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { MenuState } from './HeaderContextMenu'
import type { EnrichMenuAction, RunByColumn, RunMenuActions } from './types'

interface Props {
  columnId: string
  selectedRowIndices?: number[]
  activeHTTPRunsByColumn: RunByColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
}

const ITEM = 'text-gray-700 focus:text-gray-900'

// "Enrichment Actions" on an enrichment's status column. Every run here goes
// through the enrichment start (with a confirm that quotes the estimate), not
// the plain HTTP rerun, which refuses enrichment columns. While a run on the
// column is active, only watching and stopping it are offered: a second run
// on the same column is refused until it ends.
export const EnrichColumnActions: React.FC<Props> = ({
  columnId, selectedRowIndices, activeHTTPRunsByColumn, setMenu, actions,
}) => {
  const { onEnrichAction } = actions
  if (!onEnrichAction) return null
  const act = (action: EnrichMenuAction, rows?: number[]) => () => {
    onEnrichAction(action, columnId, rows)
    setMenu(null)
  }
  const active = !!activeHTTPRunsByColumn[columnId]
  const selected = selectedRowIndices ?? []
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Enrichment Actions</DropdownMenuLabel>
      {!active && (
        <>
          <DropdownMenuItem onClick={act('not_enriched')} className={ITEM}>🔄 Run Rows Not Enriched</DropdownMenuItem>
          <DropdownMenuItem onClick={act('failed')} className={ITEM}>🔁 Retry Failed Rows</DropdownMenuItem>
          {selected.length > 0 && (
            <DropdownMenuItem onClick={act('selected', selected)} className={ITEM}>
              🔄 Run Selected Rows ({selected.length.toLocaleString()})
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={act('all')} className={ITEM}>🔄 Run All Rows Again</DropdownMenuItem>
        </>
      )}
      <DropdownMenuItem onClick={act('edit')} className={ITEM}>✏️ Edit Enrichment</DropdownMenuItem>
      {active && (
        <>
          <DropdownMenuItem onClick={act('view')} className={ITEM}>📈 View Run</DropdownMenuItem>
          <DropdownMenuItem onClick={act('stop')} className="text-red-600 focus:text-red-600">
            🟥 Stop Enrichment Run
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

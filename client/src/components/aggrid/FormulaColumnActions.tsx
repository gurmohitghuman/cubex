import React from 'react'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { AutorunColumn } from '@/utils/api/types-autorun'
import type { MenuState } from './HeaderContextMenu'
import type { FormulaMenuAction, RunMenuActions } from './types'

interface Props {
  columnId: string
  autorun?: AutorunColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
}

const ITEM = 'text-gray-700 focus:text-gray-900'

// A formula column's block in its menu: edit the formula, work every row out
// again, and switch its auto-run, which has no rule or caps (a formula is
// free), so it has no dialog.
export const FormulaColumnActions: React.FC<Props> = ({ columnId, autorun, setMenu, actions }) => {
  const { onFormulaAction } = actions
  if (!onFormulaAction) return null
  const act = (action: FormulaMenuAction) => () => { onFormulaAction(action, columnId); setMenu(null) }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Formula Actions</DropdownMenuLabel>
      <DropdownMenuItem onClick={act('edit')} className={ITEM}>✏️ Edit formula…</DropdownMenuItem>
      <DropdownMenuItem onClick={act('again')} className={ITEM}>🔄 Work out every row again</DropdownMenuItem>
      {autorun?.enabled && autorun.pausedReason && autorun.pausedReason !== 'user' && (
        <DropdownMenuItem onClick={act('autorun_on')} className={ITEM}>⚡ Resume Auto-run</DropdownMenuItem>
      )}
      {autorun?.enabled ? (
        <DropdownMenuItem onClick={act('autorun_off')} className={ITEM}>⚡ Turn Off Auto-run</DropdownMenuItem>
      ) : (
        <DropdownMenuItem onClick={act('autorun_on')} className={ITEM}>⚡ Turn On Auto-run</DropdownMenuItem>
      )}
    </>
  )
}

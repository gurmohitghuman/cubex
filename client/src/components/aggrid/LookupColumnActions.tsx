import React from 'react'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { AutorunColumn } from '@/utils/api/types-autorun'
import type { MenuState } from './HeaderContextMenu'
import type { LookupMenuAction, RunMenuActions } from './types'

interface Props {
  columnId: string
  autorun?: AutorunColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
}

const ITEM = 'text-gray-700 focus:text-gray-900'

// A lookup column's block in its menu: edit the lookup, look every row up
// again (the other sheet's changes don't update it on their own), and switch
// its auto-run, which has no rule or caps (a lookup is free).
export const LookupColumnActions: React.FC<Props> = ({ columnId, autorun, setMenu, actions }) => {
  const { onLookupAction } = actions
  if (!onLookupAction) return null
  const act = (action: LookupMenuAction) => () => { onLookupAction(action, columnId); setMenu(null) }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Lookup Actions</DropdownMenuLabel>
      <DropdownMenuItem onClick={act('edit')} className={ITEM}>✏️ Edit lookup…</DropdownMenuItem>
      <DropdownMenuItem onClick={act('again')} className={ITEM}>🔄 Look up every row again</DropdownMenuItem>
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

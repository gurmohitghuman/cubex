import React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { AutorunColumn } from '@/utils/api/types-autorun'
import type { MenuState } from './HeaderContextMenu'
import type { RunMenuActions } from './types'

interface Props {
  columnId: string
  autorun?: AutorunColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
}

const ITEM = 'text-gray-700 focus:text-gray-900'

// The column menu's auto-run items, in the Enrichment and HTTP API blocks:
// Turn On opens the auto-run dialog; once on, its settings and Turn Off.
export const AutorunMenuItems: React.FC<Props> = ({ columnId, autorun, setMenu, actions }) => {
  const { onAutorunAction } = actions
  if (!onAutorunAction) return null
  const go = (action: 'open' | 'off') => () => { onAutorunAction(columnId, action); setMenu(null) }
  if (!autorun?.enabled) {
    return <DropdownMenuItem onClick={go('open')} className={ITEM}>⚡ Turn On Auto-run</DropdownMenuItem>
  }
  return (
    <>
      <DropdownMenuItem onClick={go('open')} className={ITEM}>⚡ Auto-run Settings</DropdownMenuItem>
      <DropdownMenuItem onClick={go('off')} className={ITEM}>⚡ Turn Off Auto-run</DropdownMenuItem>
    </>
  )
}

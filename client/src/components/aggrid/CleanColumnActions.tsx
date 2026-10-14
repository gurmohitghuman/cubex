import React from 'react'
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { AutorunColumn } from '@/utils/api/types-autorun'
import type { MenuState } from './HeaderContextMenu'
import type { CleanMenuAction, RunMenuActions } from './types'

interface Props {
  columnId: string
  // The column is a clean data column (its own block below).
  isClean: boolean
  autorun?: AutorunColumn
  setMenu: (m: MenuState) => void
  actions: RunMenuActions
}

const ITEM = 'text-gray-700 focus:text-gray-900'

// Every column offers "Clean data…" (a new column cleaned from this one, a
// clean column included). A clean column also gets its own block: edit how
// it's cleaned, clean every row again, and switch its auto-run, which has no
// rule or caps (cleaning is free), so it has no dialog.
export const CleanColumnActions: React.FC<Props> = ({ columnId, isClean, autorun, setMenu, actions }) => {
  const { onCleanAction } = actions
  if (!onCleanAction) return null
  const act = (action: CleanMenuAction) => () => { onCleanAction(action, columnId); setMenu(null) }
  return (
    <>
      <DropdownMenuItem onClick={act('new')} className={ITEM}>Clean data…</DropdownMenuItem>
      {isClean && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Clean Data Actions</DropdownMenuLabel>
          <DropdownMenuItem onClick={act('edit')} className={ITEM}>✏️ Edit cleaning…</DropdownMenuItem>
          <DropdownMenuItem onClick={act('again')} className={ITEM}>🔄 Clean all rows again</DropdownMenuItem>
          {autorun?.enabled ? (
            <DropdownMenuItem onClick={act('autorun_off')} className={ITEM}>⚡ Turn Off Auto-run</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={act('autorun_on')} className={ITEM}>⚡ Turn On Auto-run</DropdownMenuItem>
          )}
        </>
      )}
    </>
  )
}

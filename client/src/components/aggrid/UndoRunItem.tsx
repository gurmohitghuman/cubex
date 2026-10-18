import React from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { MenuState } from './HeaderContextMenu'
import type { RunMenuActions } from './types'

// "Undo last run" in a run column's menu (AI, HTTP API, enrichment and
// waterfall blocks), while no run is going on it: the confirm reads which run
// it would undo (hooks/sheet/useRunUndo.ts).
export const UndoRunItem: React.FC<{ columnId: string; setMenu: (m: MenuState) => void; actions: RunMenuActions }> = ({
  columnId, setMenu, actions,
}) => {
  const undo = actions.onUndoRun
  if (!undo) return null
  return (
    <DropdownMenuItem onClick={() => { undo(columnId); setMenu(null) }} className="text-gray-700 focus:text-gray-900"
      data-testid="undo-run">
      ↩️ Undo last run…
    </DropdownMenuItem>
  )
}

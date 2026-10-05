import React, { useState } from 'react'
import { Plus, ChevronUp } from 'lucide-react'
import { Sheet } from '@/utils/api'
import { AddRowButton } from '@/components/AddRowButton'
import { useSheetTabDrag } from '@/hooks/sheet/useSheetTabDrag'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

interface SheetTabsBarProps {
  sheets: Sheet[]
  activeSheet: Sheet | null
  onSelectSheet: (s: Sheet) => void
  onAddSheet: () => void
  onRenameSheet: (sheetId: string, name: string) => void
  onDeleteSheet: (s: Sheet) => void
  onReorderSheets: (orderedSheetIds: string[]) => void
  onAddRows: (count: number) => void
}

type RenameState = { sheetId: string; value: string } | null

// One consolidated bottom bar: the add-rows control on the left (its original position),
// then the sheet tabs to its right. Always visible so tabs + the "+" stay reachable even
// on an empty sheet. Each tab has an up-chevron (⌃) that opens a Rename / Delete menu;
// double-click a tab also starts an inline rename. Rename is inline (Enter commits, Escape
// cancels). Delete opens the parent's ConfirmDialog; hidden for the last sheet (server
// 400s it anyway). Tabs drag-reorder (native HTML5, useSheetTabDrag) — pointer-only,
// matching column reorder (AG-Grid drag) and the Google-Sheets/Excel tab UX; keyboard
// reorder is a deliberate non-goal here (would be inconsistent with the rest of the app).
export const SheetTabsBar: React.FC<SheetTabsBarProps> = ({
  sheets, activeSheet, onSelectSheet, onAddSheet, onRenameSheet, onDeleteSheet,
  onReorderSheets, onAddRows,
}) => {
  const [renaming, setRenaming] = useState<RenameState>(null)
  const drag = useSheetTabDrag({ orderedIds: sheets.map(s => s.id), onReorder: onReorderSheets })
  // Insertion caret: a 2px bar at the gap the drop would insert into.
  const caret = (side: 'left' | 'right') => (
    <span
      className={`absolute ${side === 'left' ? 'left-0' : 'right-0'} top-1 bottom-1 w-0.5 bg-cube-black z-10`}
      aria-hidden
    />
  )

  const commitRename = () => {
    if (!renaming) return
    const value = renaming.value.trim()
    const sheet = sheets.find(s => s.id === renaming.sheetId)
    if (value && sheet && value !== sheet.name) onRenameSheet(renaming.sheetId, value)
    setRenaming(null)
  }

  if (sheets.length === 0) return null
  return (
    // FLAT design: a single flat bar, no shadows/gradients/raised tabs. The active tab is
    // signalled by a solid brand top-line + white fill + darker text; inactive tabs are
    // flat gray on the bar. Plain rectangles, minimal chrome.
    <div className="flex items-stretch border-t border-gray-200 bg-gray-50 pl-6 pr-2 h-9">
      {/* Add-rows control on the left (its original position); sheet tabs follow it. */}
      <div className="flex items-center pr-3 mr-3 border-r border-gray-200">
        <AddRowButton onAddRows={onAddRows} />
      </div>
      {/* Scrolls sideways when the tabs don't fit (a wheel scrolls it too), so
          every sheet and the "+" stay reachable. */}
      <div
        className="flex items-stretch min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
        onDragLeave={drag.handleStripDragLeave}
        onWheel={e => { if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY }}
      >
        {sheets.map((sheet, index) => {
          const isActive = activeSheet?.id === sheet.id
          if (renaming?.sheetId === sheet.id) {
            return (
              <input
                key={sheet.id}
                autoFocus
                aria-label={`Rename sheet ${sheet.name}`}
                value={renaming.value}
                onChange={(e) => setRenaming({ sheetId: sheet.id, value: e.target.value })}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  else if (e.key === 'Escape') setRenaming(null)
                }}
                className="input !py-0.5 !px-2 text-[13px] w-28 self-center"
              />
            )
          }
          return (
            <div
              key={sheet.id}
              // Drop TARGET (you drop onto a tab); the drag SOURCE is only the name
              // button below, so starting to open the chevron menu can't kick off a drag.
              // Left half of the tab inserts before it, right half after (midpoint rule).
              onDragOver={(e) => drag.handleTabDragOver(e, index)}
              onDrop={drag.handleDrop}
              onDragEnd={drag.handleDragEnd}
              className={[
                'group relative flex items-stretch shrink-0 whitespace-nowrap transition-colors duration-150',
                isActive
                  ? 'bg-white text-cube-black'
                  : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800',
                drag.dragId === sheet.id ? 'opacity-50' : '',
              ].join(' ')}
            >
              {drag.dragId && drag.dropGap === index && caret('left')}
              {drag.dragId && drag.dropGap === sheets.length && index === sheets.length - 1 &&
                caret('right')}
              {/* Flat brand accent: a solid top-line marking the active sheet. No shadow,
                  no lift — just a 2px bar of cube-black. */}
              {isActive && (
                <span className="absolute inset-x-0 top-0 h-0.5 bg-cube-black" aria-hidden />
              )}
              <button
                type="button"
                draggable
                onDragStart={(e) => drag.handleDragStart(e, sheet.id)}
                onClick={() => onSelectSheet(sheet)}
                onDoubleClick={() => setRenaming({ sheetId: sheet.id, value: sheet.name })}
                aria-current={isActive ? 'page' : undefined}
                className={`pl-3.5 pr-1.5 text-[13px] cursor-grab active:cursor-grabbing ${isActive ? 'font-semibold' : 'font-medium'}`}
              >
                {sheet.name}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Sheet options for ${sheet.name}`}
                    className={`pr-2 pl-0.5 flex items-center transition-colors ${
                      isActive ? 'text-gray-400 hover:text-cube-black' : 'text-gray-400 hover:text-gray-700'
                    }`}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                {/* Trigger is the chevron (right end of the tab). align="start" puts the
                    menu's LEFT edge at the chevron and it opens rightward; the negative
                    alignOffset slides that left edge back under the sheet name so the menu
                    starts under the tab and extends right (not spilling far past it). */}
                <DropdownMenuContent className="w-44" align="start" alignOffset={-72} side="top" sideOffset={6}>
                  <DropdownMenuItem onClick={() => setRenaming({ sheetId: sheet.id, value: sheet.name })}>
                    Rename
                  </DropdownMenuItem>
                  {sheets.length > 1 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-red-600 focus:text-red-700"
                        onClick={() => onDeleteSheet(sheet)}
                      >Delete</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        })}
        <button
          onClick={onAddSheet}
          title="Add sheet"
          aria-label="Add sheet"
          className="px-2 flex items-center text-gray-500 hover:text-cube-black hover:bg-gray-100 transition-colors duration-150"
        >
          <Plus className="h-4 w-4" />
        </button>
        {/* Trailing drop catch area: dropping past the "+" button moves the tab to the
            end. Invisible — the last-tab right-edge caret is the visual signal for the
            end gap. Only mounted during a drag. */}
        {drag.dragId && (
          <div
            onDragOver={drag.handleEndDragOver}
            onDrop={drag.handleDrop}
            className="w-10"
            aria-hidden
          />
        )}
      </div>
    </div>
  )
}

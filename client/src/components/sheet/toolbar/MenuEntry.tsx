import React, { useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'

interface EntryProps {
  icon: LucideIcon
  label: string
  // One line on what it does, under the name; left out where the name says it all.
  hint?: string
  onSelect: () => void
  disabled?: boolean
  testId?: string
  // A small mark after the name (auto-dedupe on).
  badge?: React.ReactNode
}

// One entry in the sheet toolbar's menus (Data, ⋯, the column types): an icon,
// a name and, when it helps, a line on what it does.
export const MenuEntry: React.FC<EntryProps> = ({ icon: Icon, label, hint, onSelect, disabled, testId, badge }) => (
  <DropdownMenuItem onSelect={onSelect} disabled={disabled} data-testid={testId}
    className="cursor-pointer items-start gap-2.5 px-2.5 py-2">
    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gray-600" aria-hidden="true" />
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-1.5 font-medium text-gray-900">{label}{badge}</span>
      {hint && <span className="text-xs text-gray-600">{hint}</span>}
    </span>
  </DropdownMenuItem>
)

// A group's name inside a toolbar menu ("Runs with your keys", "Setups").
export const MenuHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <DropdownMenuLabel className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-600">
    {children}
  </DropdownMenuLabel>
)

// Where focus goes when a toolbar menu closes. Closed without a pick (Escape, a click
// elsewhere) or by an entry that does its work at once (Export): back on the menu's button,
// as Radix does. An entry that opens a dialog or drawer (opening) opens it once the menu has
// finished closing, with focus on the menu's button: the dialog then takes focus, and gives
// it back to the button when it closes (opened sooner, the closing menu dropped focus on the
// page).
export function useMenuFocus() {
  const trigger = useRef<HTMLButtonElement>(null)
  const pending = useRef<(() => void) | null>(null)
  return {
    trigger,
    opening: (open: () => void) => () => { pending.current = open },
    onCloseAutoFocus: (e: Event) => {
      const open = pending.current
      pending.current = null
      if (!open) return
      e.preventDefault()
      trigger.current?.focus()
      open()
    },
  }
}

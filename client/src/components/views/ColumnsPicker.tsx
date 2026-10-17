import React, { useState } from 'react'
import { ChevronDown, EyeOff } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface Props {
  columns: string[]
  hidden: string[]
  onChange: (hidden: string[]) => void
}

// "12/15 columns": show or hide any column in the active view. Hiding never
// touches rows or the column order, and at least one column stays showing.
export const ColumnsPicker: React.FC<Props> = ({ columns, hidden, onChange }) => {
  const [search, setSearch] = useState('')
  const hiddenSet = new Set(hidden)
  const shown = columns.length - hidden.length
  const match = search.trim().toLowerCase()
  const listed = match ? columns.filter(c => c.toLowerCase().includes(match)) : columns
  const toggle = (column: string) => onChange(hiddenSet.has(column)
    ? hidden.filter(c => c !== column)
    : [...hidden, column])
  return (
    <DropdownMenu onOpenChange={open => { if (!open) setSearch('') }}>
      <DropdownMenuTrigger asChild>
        <button className="btn-secondary !py-1 flex items-center gap-1.5" data-testid="columns-picker"
          title="Show or hide columns in this view">
          {hidden.length > 0 && <EyeOff className="h-3 w-3" />}
          <span>{shown}/{columns.length} columns</span>
          <ChevronDown className="h-3 w-3 text-gray-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {columns.length > 10 && (
          <input className="input w-full !py-1 text-sm mb-1" placeholder="Find a column" value={search}
            onChange={e => setSearch(e.target.value)} onKeyDown={e => e.stopPropagation()} autoFocus />
        )}
        <DropdownMenuItem disabled={hidden.length === 0} onSelect={e => { e.preventDefault(); onChange([]) }}>
          Show all columns
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="max-h-80 overflow-y-auto">
          {listed.map(c => {
            const isShown = !hiddenSet.has(c)
            return (
              <DropdownMenuCheckboxItem key={c} checked={isShown} disabled={isShown && shown <= 1}
                onSelect={e => { e.preventDefault(); toggle(c) }} data-testid="column-toggle">
                <span className="truncate">{c}</span>
              </DropdownMenuCheckboxItem>
            )
          })}
          {listed.length === 0 && <p className="px-2 py-1.5 text-sm text-gray-500">No column matches.</p>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

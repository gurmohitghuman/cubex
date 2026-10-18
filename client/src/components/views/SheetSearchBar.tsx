import React from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import type { SheetSearch, SearchStatus } from '@/hooks/sheet/useSheetSearch'
import { MAX_SEARCH_CHARS } from '@/lib/constants'

// What the box says about the search: where you are among the matches.
export function searchWords(s: SearchStatus): string {
  if (s.phase === 'none') return 'No matches'
  if (s.phase === 'error') return "Couldn't search"
  if (s.phase === 'searching' && s.ordinal === null) return 'Searching…'
  const total = s.total === null ? null : `${s.total.toLocaleString()}${s.capped ? '+' : ''}`
  if (s.ordinal !== null && total !== null) return `${s.ordinal.toLocaleString()} of ${total}`
  if (total !== null) return `${total} matches`
  return 'Counting…'
}

// Search in the sheet, in the bar above the grid: Enter goes to the next
// match, Shift+Enter to the previous one, Escape clears it.
export const SheetSearchBar: React.FC<{ search: SheetSearch }> = ({ search }) => {
  const { query, status } = search
  const active = query.trim() !== ''
  const button = 'p-1 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-40'
  return (
    <div className="ml-auto flex items-center gap-1 flex-shrink-0" data-testid="sheet-search">
      <label className="relative flex items-center">
        <Search className="absolute left-2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
        <input ref={search.inputRef} value={query} maxLength={MAX_SEARCH_CHARS}
          onChange={e => search.setQuery(e.target.value)} onFocus={search.takeAnchor}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) search.prev(); else search.next() }
            if (e.key === 'Escape') { e.preventDefault(); search.clear() }
          }}
          placeholder="Search (/)" aria-label="Search the sheet"
          className="w-44 focus:w-56 transition-[width] pl-7 pr-2 py-1 text-xs border border-gray-300 rounded
            focus:outline-none focus:border-cube-black" />
      </label>
      {active && (
        <>
          <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap min-w-[4.5rem] text-right"
            data-testid="search-status" aria-live="polite">{searchWords(status)}</span>
          <button className={button} onClick={search.prev} disabled={status.phase === 'none'}
            aria-label="Previous match" title="Previous match (Shift+Enter)">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button className={button} onClick={search.next} disabled={status.phase === 'none'}
            aria-label="Next match" title="Next match (Enter)">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button className={button} onClick={search.clear} aria-label="Clear search" title="Clear search (Escape)">
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  )
}

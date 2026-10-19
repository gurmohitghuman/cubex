import React, { useState } from 'react'
import { JSON_TREE_GOTO_PAGES, JSON_TREE_PAGE_ITEMS } from '@/lib/constants'

// A container's page controls, above and below its children: which part shows
// (a list by index, as its rows are labelled; an object by position), Previous
// and Next, and for a long list a box to go to an item (its page, then the item).
export function Pager({ array, start, end, total, onGo, onGoTo }: {
  array: boolean; start: number; end: number; total: number; onGo: (start: number) => void
  onGoTo: (index: number) => void
}) {
  const [goTo, setGoTo] = useState('')
  const go = () => {
    const n = Number(goTo)
    if (goTo.trim() === '' || !Number.isInteger(n) || n < 0 || n >= total) return
    onGoTo(n)
    setGoTo('')
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 font-sans text-gray-600"
      data-testid="json-tree-pager">
      <span>{array ? `Items ${start}–${end - 1}` : `Fields ${start + 1}–${end}`} of {
        total.toLocaleString('en-US')}</span>
      <button type="button" disabled={start === 0} className="underline disabled:no-underline disabled:opacity-40"
        onClick={() => onGo(Math.max(0, start - JSON_TREE_PAGE_ITEMS))}>Previous</button>
      <button type="button" disabled={end >= total} className="underline disabled:no-underline disabled:opacity-40"
        onClick={() => onGo(end)}>Next</button>
      {array && total > JSON_TREE_PAGE_ITEMS * JSON_TREE_GOTO_PAGES && (
        <input type="number" min={0} max={total - 1} value={goTo} placeholder="Go to item" aria-label="Go to item"
          className="input w-28 text-xs px-1 py-0.5" onChange={e => setGoTo(e.target.value)}
          onKeyDown={e => {
            // Handled here: a dialog around the tree must not also close on them.
            if (e.key !== 'Enter' && e.key !== 'Escape') return
            e.preventDefault(); e.stopPropagation()
            if (e.key === 'Enter') go()
            else setGoTo('')
          }} />
      )}
    </div>
  )
}

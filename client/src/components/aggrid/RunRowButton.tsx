import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Play } from 'lucide-react'
import type { RunCellApi } from './RunCellContext'

interface Props { api: RunCellApi; main: string; row: number }

const UNPRICED = 'Run this row'

// A run column cell's play button (shown while the cell is hovered or focused,
// CSS .cube-run-row): icon only, on the cell's right edge, so it never covers
// the cell's middle or the start of its value, where a click opens the answer.
// Hovering it, or reaching it from the keyboard (Tab on its focused cell), reads what running this row
// costs and shows the sentence in a note above it (RunRowNote); its label says
// the same for screen readers. A click runs the row alone with its column's
// setup. Its clicks are stopped on the button itself, with the browser's own
// listeners: AG Grid listens on the row, below React's root, so a React
// handler would stop them too late (the answer panel, the trace or the editor
// would open as well). A mousedown goes on: it closes an editor open in
// another cell, as any click in the grid does.
export const RunRowButton: React.FC<Props> = ({ api, main, row }) => {
  const [label, setLabel] = useState(UNPRICED)
  const [at, setAt] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLButtonElement>(null)
  const props = useRef({ api, main, row })
  props.current = { api, main, row }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event) => { e.stopPropagation() }
    const click = (e: MouseEvent) => {
      e.stopPropagation()
      e.preventDefault()
      // A double click's second click: the row is already starting.
      if (e.detail > 1) return
      const p = props.current
      p.api.runRow(p.main, p.row)
    }
    // From the keyboard (gridOptions.ts runButtonKey): Tab on the focused cell reaches this button, Shift+Tab on
    // it goes back to the cell, and Tab on it goes on to the next cell as the grid moves.
    const cell = el.closest<HTMLElement>('.ag-cell')
    const tabIn = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.shiftKey || e.target !== cell) return
      e.preventDefault()
      el.focus()
    }
    const tabBack = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.shiftKey || !cell) return
      e.preventDefault()
      e.stopPropagation()
      cell.focus()
    }
    el.addEventListener('dblclick', stop)
    el.addEventListener('click', click)
    el.addEventListener('keydown', tabBack)
    cell?.addEventListener('keydown', tabIn)
    return () => {
      el.removeEventListener('dblclick', stop)
      el.removeEventListener('click', click)
      el.removeEventListener('keydown', tabBack)
      cell?.removeEventListener('keydown', tabIn)
    }
  }, [])
  // Read on every hover (cached a little while): the row's inputs, and so its price, can change.
  const show = (el: HTMLButtonElement) => {
    setAt(el.getBoundingClientRect())
    api.rowCost(main, row).then(setLabel).catch(() => setLabel(UNPRICED))
  }
  // A click focuses the button too: only a keyboard's focus keeps the note up.
  const focused = (el: HTMLButtonElement) => { if (el.matches(':focus-visible')) show(el) }
  const hide = () => setAt(null)
  return (
    <>
      <button ref={ref} type="button" className="cube-run-row" data-testid="run-row" aria-label={label}
        onMouseEnter={e => show(e.currentTarget)} onMouseLeave={hide}
        onFocus={e => focused(e.currentTarget)} onBlur={hide}>
        <Play size={11} aria-hidden="true" />
      </button>
      {at && createPortal(<RunRowNote at={at} text={label} />, document.body)}
    </>
  )
}

// The price note: drawn on the page itself, since AG Grid clips what overflows a cell. It sits above the button,
// lined up with its right edge (below it near the top of the window), never wider than the room on the left, and
// takes no clicks: a click on it reaches the cell beneath. The button's label already reads it out.
const NOTE = 'fixed z-50 w-max pointer-events-none bg-white border border-gray-200 shadow-md px-2 py-1 text-xs '
  + 'text-gray-700'
const RunRowNote: React.FC<{ at: DOMRect; text: string }> = ({ at, text }) => (
  <div aria-hidden="true" data-testid="run-row-note" className={NOTE}
    style={{
      right: Math.max(8, window.innerWidth - at.right), maxWidth: Math.max(160, at.right - 8),
      ...(at.top > 48 ? { bottom: window.innerHeight - at.top + 6 } : { top: at.bottom + 6 }),
    }}>
    {text}
  </div>
)

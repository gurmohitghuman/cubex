import React, { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type { RunCellApi } from './RunCellContext'

interface Props { api: RunCellApi; main: string; row: number }

// A run column cell's play button (shown while the cell is hovered or focused,
// CSS .cube-run-row): hovering it reads what running this row costs (the short
// price on the button, the sentence in its tooltip); a click runs the row alone
// with its column's setup. Its clicks are stopped on the button itself, with
// the browser's own listeners: AG Grid listens on the row, below React's root,
// so a React handler would stop them too late (the answer panel, the trace or
// the editor would open as well). A mousedown goes on: it closes an editor open
// in another cell, as any click in the grid does.
export const RunRowButton: React.FC<Props> = ({ api, main, row }) => {
  const [cost, setCost] = useState<{ short: string; label: string } | null>(null)
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
    el.addEventListener('dblclick', stop)
    el.addEventListener('click', click)
    return () => {
      el.removeEventListener('dblclick', stop)
      el.removeEventListener('click', click)
    }
  }, [])
  // Read on every hover (cached a little while): the row's inputs, and so its price, can change.
  const priced = () => { api.rowCost(main, row).then(setCost).catch(() => setCost(null)) }
  const label = cost?.label ?? 'Run this row'
  return (
    <button ref={ref} type="button" className="cube-run-row" data-testid="run-row" aria-label={label} title={label}
      onMouseEnter={priced} onFocus={priced}>
      <Play size={11} aria-hidden="true" />
      {cost && <span className="cube-run-row-cost" data-testid="run-row-cost">{cost.short}</span>}
    </button>
  )
}

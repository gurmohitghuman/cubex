import React from 'react'
import {
  VALUE_FILTERS, filterText, isListFilter, isValueFilter, sameFilter, valueFilterFrom,
  type ColumnFilter, type ValueFilterOp,
} from '@/lib/filters'

// The column menu's value filter: an operator and its value (one value per
// line for "is any of"). Seeded from the column's current value filter;
// applies on Enter, on the Apply button, on leaving the field, or right away
// when the operator changes with a value typed (not into or out of a list). Not per keystroke: each apply
// is a server PUT + reload (the grid is windowed, so filtering is
// server-side). Applying clears the column's empty filter (one filter per
// column). stopPropagation keeps typing and clicks inside the Radix menu from
// closing it or jumping between items.
export const ColumnFilterEditor: React.FC<{
  columnId: string
  current: ColumnFilter | undefined
  onApply: (filter: ColumnFilter | null) => void
  hasEmptyFilter: boolean
  onClearEmpty: () => void
}> = ({ columnId, current, onApply, hasEmptyFilter, onClearEmpty }) => {
  const saved = current && isValueFilter(current.type) ? current : undefined
  const [op, setOp] = React.useState<ValueFilterOp>(saved ? (saved.type as ValueFilterOp) : 'contains')
  const [text, setText] = React.useState(filterText(saved))
  const [error, setError] = React.useState<string | null>(null)
  const box = React.useRef<HTMLDivElement>(null)
  // Re-seed when the menu reopens on a different column / after an external change.
  React.useEffect(() => {
    setOp(saved ? (saved.type as ValueFilterOp) : 'contains')
    setText(filterText(saved))
    setError(null)
  }, [JSON.stringify(saved ?? null), columnId]) // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (nextOp = op) => {
    const next = valueFilterFrom(nextOp, text)
    if (typeof next === 'string') { setError(next); return }
    setError(null)
    if (sameFilter(next, saved)) return // no-op: avoid a needless PUT + reload
    if (next && hasEmptyFilter) onClearEmpty()
    // Clearing the field removes only a value filter; a run-state filter stays.
    if (next || saved) onApply(next)
  }

  // A new condition on the same kind of value applies at once; into or out of
  // a list it waits for Enter or Apply (leaving a list keeps its first value).
  const pickOp = (next: ValueFilterOp) => {
    const intoOrOutOfList = isListFilter(op) !== isListFilter(next)
    setOp(next)
    if (isListFilter(op) && !isListFilter(next)) setText(text.split('\n').map(v => v.trim()).find(Boolean) ?? '')
    if (!intoOrOutOfList && text.trim()) apply(next)
  }

  const built = valueFilterFrom(op, text)
  const dirty = typeof built === 'string' || !sameFilter(built, saved)
  const list = isListFilter(op)
  const leaving = (e: React.FocusEvent) => { if (!box.current?.contains(e.relatedTarget as Node)) apply() }
  const frame = 'text-sm border border-gray-300 rounded py-1 focus:outline-none focus:border-cube-black'
  const field = `w-full px-2 ${frame}`
  const hint = list ? 'One per line, then Apply'
    : dirty && text.trim() ? 'Press Enter to apply' : 'Type, then press Enter'

  return (
    <div ref={box} className="px-2 py-1.5 space-y-1" onKeyDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <select value={op} aria-label="Filter condition"
          onChange={e => pickOp(e.target.value as ValueFilterOp)}
          className={`flex-1 px-1 bg-white ${frame}`}>
          {VALUE_FILTERS.map(f => <option key={f.op} value={f.op}>{f.label}</option>)}
        </select>
        {saved && (
          <button onClick={() => { setText(''); setError(null); onApply(null) }}
            className="text-gray-400 hover:text-gray-700 text-sm px-1" title="Clear filter" aria-label="Clear filter">
            ✕
          </button>
        )}
      </div>
      {list ? (
        <textarea autoFocus rows={3} value={text} onChange={e => setText(e.target.value)} onBlur={leaving}
          placeholder="One value per line" className={`${field} resize-none`} />
      ) : (
        <input autoFocus value={text} onChange={e => setText(e.target.value)} onBlur={leaving}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply() } }}
          placeholder={op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte' ? 'A number…' : 'Text…'}
          className={field} />
      )}
      <div className="flex items-center justify-between gap-1">
        <p className={`text-[10px] ${error ? 'text-red-600' : 'text-gray-400'}`}>
          {error ?? hint}
        </p>
        {dirty && text.trim() && (
          <button onClick={() => apply()} title="Apply filter"
            className="text-[10px] font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded px-1.5 py-0.5">
            Apply
          </button>
        )}
      </div>
    </div>
  )
}

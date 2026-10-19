import React from 'react'
import {
  VALUE_FILTERS, filterText, isDateFilter, isListFilter, isValueFilter, sameFilter, valueFilterFrom,
  type ColumnFilter, type ValueFilterOp,
} from '@/lib/filters'
import { MAX_FILTER_LIST_VALUES, MAX_FILTER_VALUE_CHARS } from '@/lib/constants'
import { ValuePicker, keepFocus } from './ValuePicker'
import { DateValueInput } from '../filters/DateValueInput'

// A list filter from picked values (null: none picked), or a message.
function listFilterFrom(op: ValueFilterOp, values: string[]): ColumnFilter | null | string {
  if (values.length === 0) return null
  if (values.length > MAX_FILTER_LIST_VALUES) return `At most ${MAX_FILTER_LIST_VALUES} values.`
  if (values.some(v => v.length > MAX_FILTER_VALUE_CHARS)) {
    return `A value can be at most ${MAX_FILTER_VALUE_CHARS} characters.`
  }
  return { type: op, values }
}

// The column menu's value filter: an operator and its value, or for "is any
// of" / "is none of" values picked from the column's most common ones (with
// counts) or typed (ValuePicker). Seeded from the column's current value
// filter; applies on Enter, on the Apply button, on leaving the field, or
// right away when the operator changes with a value typed (not into or out of
// a list). Not per keystroke: each apply is a server PUT + reload (the grid
// is windowed, so filtering is server-side). Applying clears the column's
// empty filter (one filter per column). stopPropagation keeps typing and
// clicks inside the Radix menu from closing it or jumping between items.
export const ColumnFilterEditor: React.FC<{
  columnId: string
  sheetId?: string
  current: ColumnFilter | undefined
  onApply: (filter: ColumnFilter | null) => void
  hasEmptyFilter: boolean
  onClearEmpty: () => void
}> = ({ columnId, sheetId, current, onApply, hasEmptyFilter, onClearEmpty }) => {
  const saved = current && isValueFilter(current.type) ? current : undefined
  const [op, setOp] = React.useState<ValueFilterOp>(saved ? (saved.type as ValueFilterOp) : 'contains')
  const [text, setText] = React.useState(saved?.values ? '' : filterText(saved))
  const [picked, setPicked] = React.useState<string[]>(saved?.values ?? [])
  const [error, setError] = React.useState<string | null>(null)
  const box = React.useRef<HTMLDivElement>(null)
  // Re-seed when the menu reopens on a different column / after an external change.
  React.useEffect(() => {
    setOp(saved ? (saved.type as ValueFilterOp) : 'contains')
    setText(saved?.values ? '' : filterText(saved))
    setPicked(saved?.values ?? [])
    setError(null)
  }, [JSON.stringify(saved ?? null), columnId]) // eslint-disable-line react-hooks/exhaustive-deps

  const list = isListFilter(op)
  const build = (nextOp: ValueFilterOp) =>
    (isListFilter(nextOp) ? listFilterFrom(nextOp, picked) : valueFilterFrom(nextOp, text))
  const apply = (nextOp = op) => {
    const next = build(nextOp)
    if (typeof next === 'string') { setError(next); return }
    setError(null)
    if (sameFilter(next, saved)) return // no-op: avoid a needless PUT + reload
    if (next && hasEmptyFilter) onClearEmpty()
    // Clearing the field removes only a value filter; a run-state filter stays.
    if (next || saved) onApply(next)
  }

  // A new condition on the same kind of value applies at once; into or out of
  // a list it waits for Enter or Apply (leaving a list keeps its first value,
  // entering one starts from the typed value).
  const pickOp = (next: ValueFilterOp) => {
    const intoOrOutOfList = list !== isListFilter(next)
    setOp(next)
    if (list && !isListFilter(next)) setText(picked.find(v => v.trim()) ?? '')
    if (!list && isListFilter(next) && text.trim() && picked.length === 0) setPicked([text.trim()])
    if (!intoOrOutOfList && (list ? picked.length > 0 : text.trim())) apply(next)
  }

  const built = build(op)
  const dirty = typeof built === 'string' || !sameFilter(built, saved)
  const filled = list ? picked.length > 0 : !!text.trim()
  const leaving = (e: React.FocusEvent) => { if (!box.current?.contains(e.relatedTarget as Node)) apply() }
  const frame = 'text-sm border border-gray-300 rounded py-1 focus:outline-none focus:border-cube-black'
  const hint = list ? (dirty && filled ? 'Pick values, then Apply' : 'Pick or type values')
    : dirty && text.trim() ? 'Press Enter to apply' : isDateFilter(op) ? 'Pick or type a date, then press Enter'
    : 'Type, then press Enter'

  return (
    <div ref={box} className="px-2 py-1.5 space-y-1" onKeyDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()} onBlur={list ? leaving : undefined}>
      <div className="flex items-center gap-1">
        <select value={op} aria-label="Filter condition"
          onChange={e => pickOp(e.target.value as ValueFilterOp)}
          className={`select-compact flex-1 px-1 bg-white ${frame}`}>
          {VALUE_FILTERS.map(f => <option key={f.op} value={f.op}>{f.label}</option>)}
        </select>
        {saved && (
          <button onClick={() => { setText(''); setPicked([]); setError(null); onApply(null) }}
            className="text-gray-400 hover:text-gray-700 text-sm px-1" title="Clear filter" aria-label="Clear filter">
            ✕
          </button>
        )}
      </div>
      {list ? (
        <ValuePicker sheetId={sheetId} column={columnId} picked={picked} onChange={setPicked} />
      ) : isDateFilter(op) ? (
        <DateValueInput autoFocus value={text} onChange={setText} onBlur={leaving} onCommit={() => apply()}
          className={`w-full px-2 ${frame}`} />
      ) : (
        <input autoFocus value={text} onChange={e => setText(e.target.value)} onBlur={leaving}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply() } }}
          placeholder={op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte' ? 'A number…' : 'Text…'}
          className={`w-full px-2 ${frame}`} />
      )}
      <div className="flex items-center justify-between gap-1">
        <p className={`text-[10px] ${error ? 'text-red-600' : 'text-gray-400'}`}>
          {error ?? (list && picked.length ? `${picked.length} picked. ${hint}` : hint)}
        </p>
        {dirty && (filled || (list && saved)) && (
          <button onClick={() => apply()} onMouseDown={keepFocus} title="Apply filter"
            className="text-[10px] font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded px-1.5 py-0.5">
            Apply
          </button>
        )}
      </div>
    </div>
  )
}

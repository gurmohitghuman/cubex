import React from 'react'
import { searchAPI, type ValueCountsResult } from '@/utils/api'
import { MAX_FILTER_LIST_VALUES } from '@/lib/constants'

// "Is any of" / "Is none of" values: the column's most common values with how
// many rows hold each (counted over the view's other filters, server
// services/value-counts.ts), a box to narrow the list, and any value typed
// there (Enter, or paste several lines) added as it is. Values compare as the
// filter does: case and outer spaces ignored.
export const EMPTY_VALUE = ''
// Clicking a value keeps the focus in the search box: leaving the editor applies the filter.
export const keepFocus = (e: React.MouseEvent) => e.preventDefault()

const fold = (v: string) => v.trim().toLowerCase()
const FIELD = 'w-full px-2 text-sm border border-gray-300 rounded py-1 focus:outline-none focus:border-cube-black'

export const ValuePicker: React.FC<{
  sheetId?: string
  column: string
  picked: string[]
  onChange: (values: string[]) => void
}> = ({ sheetId, column, picked, onChange }) => {
  const [answer, setAnswer] = React.useState<ValueCountsResult | 'loading' | 'failed'>('loading')
  const [term, setTerm] = React.useState('')
  React.useEffect(() => {
    if (!sheetId) { setAnswer('failed'); return }
    const ctrl = new AbortController()
    setAnswer('loading')
    searchAPI.values(sheetId, column, ctrl.signal).then(setAnswer)
      .catch(e => { if (!ctrl.signal.aborted && e?.code !== 'ERR_CANCELED') setAnswer('failed') })
    return () => ctrl.abort()
  }, [sheetId, column])

  const chosen = new Set(picked.map(fold))
  const toggle = (value: string) => onChange(chosen.has(fold(value))
    ? picked.filter(p => fold(p) !== fold(value)) : [...picked, value].slice(0, MAX_FILTER_LIST_VALUES))
  const add = (lines: string[]) => {
    const fresh = lines.map(l => l.trim()).filter(l => l && !chosen.has(fold(l)))
    if (fresh.length) onChange([...picked, ...new Set(fresh)].slice(0, MAX_FILTER_LIST_VALUES))
    setTerm('')
  }

  const counted = typeof answer === 'object' && !('tooMany' in answer) && !('busy' in answer) ? answer : null
  const listed = new Set(counted?.values.map(v => fold(v.value)) ?? [])
  const t = fold(term)
  const rows = [
    // Picked values the list doesn't show (typed, or rarer than the top values).
    ...picked.filter(p => !listed.has(fold(p)) && p !== EMPTY_VALUE)
      .map(value => ({ value, count: null as number | null })),
    ...(counted?.values ?? []),
  ].filter(r => !t || fold(r.value).includes(t))
  const showEmpty = !!counted && counted.empty > 0 && (!t || '(empty)'.includes(t))
  const typedNew = term.trim() && !chosen.has(t) && !listed.has(t)

  const item = (value: string, label: string, count: number | null) => (
    <label key={`v:${value}`} title={label} onMouseDown={keepFocus}
      className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-gray-50 cursor-pointer">
      <input type="checkbox" checked={chosen.has(fold(value))} onChange={() => toggle(value)}
        className="flex-shrink-0" />
      <span className={`flex-1 truncate ${value === EMPTY_VALUE ? 'italic text-gray-500' : ''}`}>{label}</span>
      {count !== null && <span className="text-gray-400 tabular-nums">{count.toLocaleString()}</span>}
    </label>
  )

  return (
    <div className="space-y-1" data-testid="value-picker">
      <input autoFocus value={term} onChange={e => setTerm(e.target.value)}
        placeholder="Search or type a value…"
        onKeyDown={e => { if (e.key === 'Enter' && term.trim()) { e.preventDefault(); add([term]) } }}
        onPaste={e => {
          const text = e.clipboardData.getData('text')
          if (text.includes('\n')) { e.preventDefault(); add(text.split(/\r?\n/)) }
        }}
        className={FIELD} />
      <div className="max-h-44 overflow-y-auto text-xs" role="group" aria-label="Values">
        {typedNew && (
          <button onClick={() => add([term])} onMouseDown={keepFocus}
            className="w-full text-left px-1 py-0.5 rounded hover:bg-gray-50 text-gray-700">
            + Add “{term.trim()}”
          </button>
        )}
        {rows.map(r => item(r.value, r.value, r.count))}
        {showEmpty && item(EMPTY_VALUE, '(empty)', counted!.empty)}
      </div>
      <p className="text-[10px] text-gray-400" data-testid="value-picker-note">
        {answer === 'loading' ? 'Counting values…'
          : answer === 'failed' ? "Couldn't count the values. Type them instead."
          : 'tooMany' in answer ? 'Too many different values to list. Type the ones you want.'
          : 'busy' in answer ? `${answer.error} Type values meanwhile.`
          : answer.truncated ? `The ${answer.values.length.toLocaleString()} most common of `
            + `${answer.distinct.toLocaleString()} values. Type any other.`
          : `${answer.distinct.toLocaleString()} different value${answer.distinct === 1 ? '' : 's'}.`}
      </p>
    </div>
  )
}

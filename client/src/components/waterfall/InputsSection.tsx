import React, { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { DraftInput } from './draft'

interface Props {
  inputs: DraftInput[]
  columns: string[]
  onChange: (inputs: DraftInput[]) => void
  inUse: Set<string>      // inputs a step reads or requires: they stay
}

const KEY = /^[a-z][a-z0-9_]{0,39}$/
const keyOf = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  .replace(/^(\d)/, 'n$1').slice(0, 40)

// The waterfall's inputs, each mapped ONCE to a column of the sheet (or a
// fixed value): every step reads these, never a column, so moving a column
// changes every step at once. An input left unmapped reads empty, and a step
// that needs it skips its rows.
export const InputsSection: React.FC<Props> = ({ inputs, columns, onChange, inUse }) => {
  const [adding, setAdding] = useState('')
  const set = (i: number, patch: Partial<DraftInput>) =>
    onChange(inputs.map((x, k) => (k === i ? { ...x, ...patch } : x)))
  const newKey = keyOf(adding)
  const canAdd = KEY.test(newKey) && !inputs.some(i => i.key === newKey)
  const add = () => {
    if (!canAdd) return
    onChange([...inputs, { key: newKey, label: adding.trim(), source: null }])
    setAdding('')
  }
  return (
    <div className="space-y-2" data-testid="waterfall-inputs">
      {inputs.map((input, i) => {
        const value = !input.source ? '' : 'column' in input.source ? `c:${input.source.column}` : 'fixed'
        const lost = !!input.source && 'column' in input.source && !columns.includes(input.source.column)
        return (
          <div key={input.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-start gap-2"
            data-testid={`waterfall-input-${input.key}`}>
            <label className="text-sm text-gray-700 pt-2 break-words" title={`Steps read it as ${input.key}`}>
              {input.label}<span className="block text-[11px] text-gray-400 font-mono">{input.key}</span>
            </label>
            <div className="space-y-1 min-w-0">
              <select className="input w-full" value={value} aria-label={input.label}
                onChange={e => {
                  const v = e.target.value
                  set(i, { source: !v ? null : v === 'fixed' ? { value: '' } : { column: v.slice(2) } })
                }}>
                <option value="">Not mapped</option>
                {lost && (
                  <option value={value}>{(input.source as { column: string }).column} (not in the sheet)</option>
                )}
                {columns.length > 0 && (
                  <optgroup label="Columns">{columns.map(c => <option key={c} value={`c:${c}`}>{c}</option>)}</optgroup>
                )}
                <option value="fixed">Type a fixed value…</option>
              </select>
              {input.source && 'value' in input.source && (
                <input className="input w-full" value={input.source.value} placeholder="Same value for every row"
                  aria-label={`${input.label} value`} onChange={e => set(i, { source: { value: e.target.value } })} />
              )}
            </div>
            <button type="button" className="p-1.5 mt-1 text-gray-400 hover:text-gray-700 disabled:opacity-30"
              aria-label={`Remove ${input.label}`} disabled={inUse.has(input.key)}
              title={inUse.has(input.key) ? 'A step reads it: change that step first' : undefined}
              onClick={() => onChange(inputs.filter((_, k) => k !== i))}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
      <div className="flex items-center gap-2 pt-1">
        <input className="input flex-1" value={adding} placeholder="Another input, such as Country"
          aria-label="New input" onChange={e => setAdding(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        <button type="button" className="btn-secondary flex items-center gap-1" disabled={!canAdd} onClick={add}>
          <Plus className="h-3 w-3" /> Add input
        </button>
      </div>
    </div>
  )
}

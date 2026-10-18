import React from 'react'
import { Plus, X } from 'lucide-react'
import type { DraftInput } from './draft'

interface Props {
  requires: string[][] | null
  inputs: DraftInput[]
  // What the step needs when nothing is set here.
  defaultText: string
  onChange: (requires: string[][] | null) => void
}

// The inputs a step needs, as alternatives ("Full name + Company domain", or
// "LinkedIn URL"): a row with none of them skips the step at no cost. Unset,
// the step needs what it reads (an enrichment step: its tool's own rule).
export const RequiresField: React.FC<Props> = ({ requires, inputs, defaultText, onChange }) => {
  const labelOf = (key: string) => inputs.find(i => i.key === key)?.label ?? key
  if (!requires) {
    return (
      <p className="text-xs text-gray-500">
        Needs {defaultText}.{' '}
        <button type="button" className="underline hover:no-underline"
          onClick={() => onChange([inputs.slice(0, 1).map(i => i.key)].filter(a => a.length))}>
          Choose what it needs
        </button>
      </p>
    )
  }
  const toggle = (alt: number, key: string) => onChange(requires.map((a, k) => (k !== alt ? a
    : a.includes(key) ? a.filter(x => x !== key) : [...a, key])).filter(a => a.length > 0))
  return (
    <div className="space-y-1.5" data-testid="waterfall-requires">
      <p className="text-xs text-gray-600">Runs on a row that has any one of these; other rows skip it for free.</p>
      {requires.map((alt, k) => (
        <div key={k} className="flex flex-wrap items-center gap-1">
          {k > 0 && <span className="text-[11px] text-gray-400 mr-1">or</span>}
          {inputs.map(i => (
            <button key={i.key} type="button" onClick={() => toggle(k, i.key)}
              className={`px-1.5 py-0.5 text-[11px] border ${alt.includes(i.key)
                ? 'border-cube-black bg-cube-black text-white' : 'border-gray-300 text-gray-600'}`}>
              {labelOf(i.key)}
            </button>
          ))}
          <button type="button" aria-label="Remove this choice" className="p-0.5 text-gray-400 hover:text-gray-700"
            onClick={() => onChange(requires.filter((_, x) => x !== k))}>
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <div className="flex gap-3">
        <button type="button" className="text-xs text-gray-600 underline hover:no-underline flex items-center gap-0.5"
          onClick={() => onChange([...requires, []])}>
          <Plus className="h-3 w-3" /> Another choice
        </button>
        <button type="button" className="text-xs text-gray-600 underline hover:no-underline"
          onClick={() => onChange(null)}>
          Back to the default
        </button>
      </div>
    </div>
  )
}

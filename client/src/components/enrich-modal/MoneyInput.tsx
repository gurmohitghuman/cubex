import React, { useState } from 'react'
import { formatCost } from '@/components/ai-modal/format'

export const parseMoney = (text: string): number | null => {
  const n = Number(text.replace(/[$,\s]/g, ''))
  return text.trim() && Number.isFinite(n) && n > 0 ? n : null
}

interface Props {
  value: number | null
  // Shown as the placeholder: what an empty field means (null: nothing).
  fallback: number | null
  label: string
  onChange: (v: number | null) => void
}

// A dollar amount; empty means "use the default" (shown as the placeholder,
// in the summary's own format). Anything else that isn't above $0 is flagged.
// Used by Rows and limits and by a paused run's "raise the limit" fixes.
export const MoneyInput: React.FC<Props> = ({ value, fallback, label, onChange }) => {
  const [text, setText] = useState(value === null ? '' : String(value))
  const invalid = text.trim() !== '' && parseMoney(text) === null
  return (
    <span className="inline-flex flex-col">
      <span className="relative inline-block">
        <span className="absolute left-2.5 top-1.5 text-sm text-gray-500">$</span>
        <input className={`input w-28 py-1 pl-6 ${invalid ? '!border-red-300' : ''}`} inputMode="decimal" value={text}
          aria-label={label} placeholder={fallback === null ? '' : formatCost(fallback).slice(1)}
          onChange={e => { setText(e.target.value); onChange(parseMoney(e.target.value)) }} />
      </span>
      {invalid && <span className="text-xs text-red-600 mt-0.5">Enter an amount above $0, or leave it empty.</span>}
    </span>
  )
}

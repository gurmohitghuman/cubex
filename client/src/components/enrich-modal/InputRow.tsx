import React from 'react'
import type { EnrichToolInput } from '@/utils/api'
import type { InputBinding } from './draft'
import { Select } from '@/components/ui/Select'

interface Props {
  input: EnrichToolInput
  label: string
  binding: InputBinding | undefined
  columns: string[]
  onChange: (binding: InputBinding | null) => void
}

const exampleText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

// One input: a column of the sheet, a fixed value typed once for every row, or
// not used. An enum input's fixed value is picked from its allowed values.
export const InputRow: React.FC<Props> = ({ input, label, binding, columns, onChange }) => {
  const value = !binding ? '' : binding.kind === 'column' ? `c:${binding.column}` : 'fixed'
  const lostColumn = binding?.kind === 'column' && !columns.includes(binding.column)
  const isBool = ['bool', 'boolean'].includes(input.type.toLowerCase())
  const choices = input.enum?.length ? input.enum.map(String) : isBool ? ['true', 'false'] : []

  const pick = (v: string) => {
    if (!v) onChange(null)
    else if (v === 'fixed') onChange({ kind: 'fixed', value: choices[0] ?? '' })
    else onChange({ kind: 'column', column: v.slice(2) })
  }

  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-start gap-2" data-testid={`enrich-input-${input.name}`}>
      <label className="text-sm text-gray-700 pt-2 break-words" title={input.note}>
        {label}{input.required && <span className="text-gray-400"> *</span>}
      </label>
      <div className="space-y-1 min-w-0">
        <Select className="w-full" value={value} onChange={pick} label={label}
          groups={[
            { label: '', options: [{ value: '', label: 'Not used' }, ...(lostColumn
              ? [{ value, label: `${(binding as { column: string }).column} (not in the sheet)` }] : [])] },
            { label: 'Columns', options: columns.map(c => ({ value: `c:${c}`, label: c })) },
            { label: '', options: [{ value: 'fixed', label: 'Type a fixed value…' }] },
          ]} />
        {binding?.kind === 'fixed' && (choices.length ? (
          <Select className="w-full" value={binding.value} onChange={v => onChange({ kind: 'fixed', value: v })}
            label={`${label} value`} options={choices.map(c => ({ value: c, label: c }))} />
        ) : (
          <input className="input w-full" value={binding.value} placeholder={exampleText(input.example) || 'Same value for every row'}
            onChange={e => onChange({ kind: 'fixed', value: e.target.value })} aria-label={`${label} value`} />
        ))}
        {lostColumn && <p className="text-xs text-red-600">That column isn&apos;t in this sheet anymore. Pick another.</p>}
      </div>
    </div>
  )
}

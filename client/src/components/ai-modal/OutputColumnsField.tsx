import React from 'react'
import { Plus, X } from 'lucide-react'
import { MAX_OUTPUT_COLUMNS_PER_RUN } from '@/lib/constants'
import { Select } from '../ui/Select'
import { OUTPUT_TYPE_LABELS, type OutputColumnDraft, type OutputColumnType } from '@/lib/output-columns'

interface Props {
  value: OutputColumnDraft[]
  onChange: (v: OutputColumnDraft[]) => void
  columnName: string
  error: string
}

const blank = (): OutputColumnDraft => ({ columnName: '', type: 'string', description: '' })

// Several typed columns filled from one answer per row (the company profile
// starter sets them up). Without any, the AI column is the one column it
// always was; the link below the prompt adds the first.
export const OutputColumnsField: React.FC<Props> = ({ value, onChange, columnName, error }) => {
  if (value.length === 0) {
    return (
      <button type="button" onClick={() => onChange([blank()])}
        className="mt-2 text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1">
        <Plus className="h-3 w-3" />Fill several columns from one answer
      </button>
    )
  }
  const set = (i: number, part: Partial<OutputColumnDraft>) =>
    onChange(value.map((o, j) => (j === i ? { ...o, ...part } : o)))
  const status = `${columnName.trim() || 'Column name'} (Status)`
  return (
    <div className="mt-3 space-y-2" data-testid="output-columns">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Output columns</span>
        <button type="button" onClick={() => onChange([])} className="text-xs text-gray-500 hover:text-gray-900">
          Use one column instead
        </button>
      </div>
      <p className="text-xs text-gray-500">
        One answer per row fills each of these columns, and &quot;{status}&quot; shows how each row went.
      </p>
      {value.map((o, i) => (
        <div key={i} className="space-y-1 border-l-2 border-gray-200 pl-2">
          <div className="flex items-center gap-1">
            <input className="input flex-1 min-w-0 text-sm" placeholder="Column name" value={o.columnName}
              aria-label={`Output column ${i + 1} name`} onChange={e => set(i, { columnName: e.target.value })} />
            <Select<OutputColumnType> className="w-28 text-sm" value={o.type} label={`Output column ${i + 1} type`}
              onChange={type => set(i, { type })}
              options={(Object.keys(OUTPUT_TYPE_LABELS) as OutputColumnType[]).map(t => (
                { value: t, label: OUTPUT_TYPE_LABELS[t] }
              ))} />
            <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="p-1 text-gray-400 hover:text-gray-800" aria-label={`Remove output column ${i + 1}`}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <input className="input w-full text-xs py-1" placeholder="What goes in it (the AI reads this)"
            value={o.description} aria-label={`Output column ${i + 1} description`}
            onChange={e => set(i, { description: e.target.value })} />
        </div>
      ))}
      {value.length < MAX_OUTPUT_COLUMNS_PER_RUN && (
        <button type="button" onClick={() => onChange([...value, blank()])}
          className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1">
          <Plus className="h-3 w-3" />Add a column
        </button>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}

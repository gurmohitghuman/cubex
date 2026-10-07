import React, { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import type { OutputPick } from './draft'
import { plural } from '@/lib/utils'

const FILTER_FROM = 10

// The answer's fields to keep as new columns, each with its column name.
// Single tools list the fields of the catalog's example answer.
export const OutputsPane: React.FC<{ outputs: OutputPick[]; onChange: (o: OutputPick[]) => void }> = ({ outputs, onChange }) => {
  const [filter, setFilter] = useState('')
  const set = (key: string, patch: Partial<OutputPick>) => onChange(outputs.map(o => (o.key === key ? { ...o, ...patch } : o)))
  const f = filter.trim().toLowerCase()
  const shown = f ? outputs.filter(o => o.label.toLowerCase().includes(f) || o.key.toLowerCase().includes(f)) : outputs

  if (outputs.length === 0) {
    return <p className="text-xs text-gray-500">This tool lists no fields yet. You can pick fields after the test run.</p>
  }
  return (
    <div className="space-y-2" data-testid="enrich-outputs">
      {outputs.length > FILTER_FROM && (
        <input type="search" className="input w-full" placeholder={`Find a field (${outputs.length})`} value={filter}
          onChange={e => setFilter(e.target.value)} aria-label="Find a field" />
      )}
      <ul className="space-y-1.5 max-h-72 overflow-y-auto">
        {shown.map(o => (
          <li key={o.key} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 min-w-0">
              <input type="checkbox" checked={o.enabled} onChange={e => set(o.key, { enabled: e.target.checked })}
                className="border-gray-300 text-cube-black focus:ring-black" />
              <span className="truncate" title={o.key}>{o.label}</span>
            </label>
            <ArrowRight className={`h-3.5 w-3.5 ${o.enabled ? 'text-gray-400' : 'text-gray-200'}`} />
            <input className="input w-full py-1 disabled:bg-gray-50 disabled:text-gray-400" value={o.columnName} disabled={!o.enabled}
              onChange={e => set(o.key, { columnName: e.target.value })} aria-label={`Column name for ${o.label}`} />
          </li>
        ))}
        {shown.length === 0 && <li className="text-xs text-gray-500">No field matches &quot;{filter}&quot;.</li>}
      </ul>
    </div>
  )
}

export function outputsSummary(outputs: OutputPick[]): string {
  const n = outputs.filter(o => o.enabled).length
  return n === 0 ? 'No new columns' : plural(n, 'column')
}

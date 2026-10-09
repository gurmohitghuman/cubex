import React, { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { plural } from '@/lib/utils'
import type { ListFieldPick } from './list-draft'

interface Props {
  fields: ListFieldPick[]
  onChange: (fields: ListFieldPick[]) => void
  dedupePath: string | null
  onDedupe: (path: string | null) => void
  // How many results the counts are out of (null: not from fresh results).
  results: number | null
}

// The search box shows from this many fields. The list itself never
// scrolls on its own (the drawer does), so no kept field is out of sight.
const FILTER_FROM = 8

// The fields the results have, each ticked to become a column of the new rows
// (with its name), how many results fill it and a sample value; and the
// optional duplicate check on one of them.
export const ListFieldsPicker: React.FC<Props> = ({ fields, onChange, dedupePath, onDedupe, results }) => {
  const [filter, setFilter] = useState('')
  const set = (path: string, patch: Partial<ListFieldPick>) =>
    onChange(fields.map(f => (f.path === path ? { ...f, ...patch } : f)))
  const f = filter.trim().toLowerCase()
  const shown = f ? fields.filter(x => x.label.toLowerCase().includes(f) || x.columnName.toLowerCase().includes(f))
    : fields
  const on = fields.filter(x => x.enabled)
  // With a filter typed, the buttons act on the fields it shows.
  const setShown = (enabled: boolean) => {
    const these = new Set(shown.map(x => x.path))
    onChange(fields.map(x => (these.has(x.path) ? { ...x, enabled } : x)))
  }

  return (
    <div className="space-y-2" data-testid="enrich-list-fields">
      <div className="flex items-center justify-between gap-2 text-xs text-gray-600">
        <span>{plural(on.length, 'field')} kept{results !== null ? `, from ${plural(results, 'result')}` : ''}</span>
        <span className="flex gap-2">
          <button type="button" className="underline hover:no-underline"
            onClick={() => setShown(true)}>{f ? 'Keep these' : 'Keep all'}</button>
          <button type="button" className="underline hover:no-underline"
            onClick={() => setShown(false)}>{f ? 'Clear these' : 'Clear'}</button>
        </span>
      </div>
      {fields.length >= FILTER_FROM && (
        <input type="search" className="input w-full" placeholder={`Find a field (${fields.length})`} value={filter}
          onChange={e => setFilter(e.target.value)} aria-label="Find a field" />
      )}
      <ul className="space-y-1.5">
        {shown.map(x => (
          <li key={x.path} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 min-w-0">
              <input type="checkbox" checked={x.enabled} onChange={e => set(x.path, { enabled: e.target.checked })}
                className="border-gray-300 text-cube-black focus:ring-black" />
              <span className="min-w-0">
                <span className="block truncate" title={x.path}>{x.label}</span>
                {(x.sample || x.filled !== undefined) && (
                  <span className="block truncate text-xs text-gray-500" title={x.sample}>
                    {x.filled !== undefined && results !== null ? `in ${x.filled} of ${results}` : ''}
                    {x.sample ? `${x.filled !== undefined && results !== null ? ' · ' : ''}${x.sample}` : ''}
                  </span>
                )}
              </span>
            </label>
            <ArrowRight className={`h-3.5 w-3.5 ${x.enabled ? 'text-gray-400' : 'text-gray-200'}`} />
            <input className="input w-full py-1 disabled:bg-gray-50 disabled:text-gray-400" value={x.columnName}
              disabled={!x.enabled} onChange={e => set(x.path, { columnName: e.target.value })}
              aria-label={`Column name for ${x.label}`} />
          </li>
        ))}
        {shown.length === 0 && <li className="text-xs text-gray-500">No field matches &quot;{filter}&quot;.</li>}
      </ul>
      <div className="flex items-center gap-2 text-sm text-gray-700 pt-1">
        <label className="flex items-center gap-2">
          {/* On with no field yet (''): the run waits until one is picked. */}
          <input type="checkbox" checked={dedupePath !== null} disabled={on.length === 0}
            onChange={e => onDedupe(e.target.checked ? '' : null)}
            className="border-gray-300 text-cube-black focus:ring-black" data-testid="enrich-list-dedupe" />
          <span>Skip results already added, matched on</span>
        </label>
        <select className="input py-1 min-w-0 flex-1" value={dedupePath ?? ''} disabled={dedupePath === null}
          onChange={e => onDedupe(e.target.value)} aria-label="Field to match on">
          <option value="">Pick a field</option>
          {on.map(x => <option key={x.path} value={x.path}>{x.columnName || x.label}</option>)}
        </select>
      </div>
      <p className="text-xs text-gray-500">
        A result that doesn&apos;t have a field leaves that cell empty. Skipping matches results added while this
        is on (the same value in the same sheet).
      </p>
    </div>
  )
}

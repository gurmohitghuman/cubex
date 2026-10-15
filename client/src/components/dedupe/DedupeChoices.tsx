import React from 'react'
import { X } from 'lucide-react'
import { DEDUPE_KEEPS, DEDUPE_MATCHES, type DedupeMatch } from '@/lib/dedupe'
import type { DedupeForm } from './useDedupeForm'

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'

// The columns rows must all match on, each with how it matches.
export const DedupeColumnsPicker: React.FC<{ form: DedupeForm }> = ({ form: f }) => (
  <div>
    <span className={LABEL}>Match on</span>
    <div className="space-y-2">
      {f.keys.map((k, i) => (
        <div key={i} data-testid="dedupe-key">
          <div className="flex items-center gap-2">
            <select className="input flex-1 min-w-0" aria-label="Column to match on" value={k.column}
              onChange={e => f.setColumn(i, e.target.value)}>
              {[k.column, ...f.unused].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="text-xs text-gray-500">as</span>
            <select className="input w-44" aria-label={`How ${k.column} matches`} value={k.match}
              onChange={e => f.setMatch(i, e.target.value as DedupeMatch)}>
              {DEDUPE_MATCHES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            {f.keys.length > 1 && (
              <button type="button" className="p-1.5 text-gray-400 hover:text-gray-700"
                aria-label={`Stop matching on ${k.column}`} onClick={() => f.removeColumn(i)}>
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">{DEDUPE_MATCHES.find(m => m.id === k.match)?.help}</p>
        </div>
      ))}
    </div>
    {f.unused.length > 0 && (
      <button type="button" className="mt-2 text-xs text-gray-700 underline" onClick={f.addColumn}
        data-testid="dedupe-add-column">
        + Add a column (rows must match on all of them)
      </button>
    )}
  </div>
)

// Which row of each group stays.
export const DedupeKeepPicker: React.FC<{ form: DedupeForm }> = ({ form: f }) => (
  <fieldset>
    <legend className={LABEL}>Keep</legend>
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      {DEDUPE_KEEPS.map(k => (
        <label key={k.id} className="flex items-center gap-1.5 text-sm text-gray-700">
          <input type="radio" name="dedupe-keep" value={k.id} checked={f.keep === k.id}
            onChange={() => f.setKeep(k.id)} className="border-gray-300 text-cube-black focus:ring-black" />
          {k.label}
        </label>
      ))}
    </div>
    <p className="text-xs text-gray-500 mt-1">{DEDUPE_KEEPS.find(k => k.id === f.keep)?.help}</p>
  </fieldset>
)

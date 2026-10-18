import React from 'react'
import { Plus, X } from 'lucide-react'
import type { HttpChoices } from '@/utils/api/waterfall'
import type { DraftInput } from './draft'

interface Props {
  choices: HttpChoices
  inputs: DraftInput[]
  onChange: (choices: HttpChoices) => void
}

// An HTTP API step: your own JSON API, its URL, headers and body filled per
// row with {{key}} for the waterfall's inputs (and /key_name for a saved API
// key), sent through Cubex's network guard, and the JSONPath of the value in
// its answer.
export const HttpStepEditor: React.FC<Props> = ({ choices, inputs, onChange }) => {
  const headers = Object.entries(choices.headers)
  const setHeaders = (list: Array<[string, string]>) => onChange({ ...choices, headers: Object.fromEntries(list) })
  const hasBody = choices.method !== 'GET' && choices.method !== 'DELETE'
  return (
    <div className="space-y-2" data-testid="waterfall-http-step">
      <div className="flex gap-2">
        <select className="input w-24" value={choices.method} aria-label="Method"
          onChange={e => onChange({ ...choices, method: e.target.value })}>
          {['GET', 'POST', 'PUT', 'DELETE'].map(m => <option key={m}>{m}</option>)}
        </select>
        <input className="input flex-1 font-mono text-xs" value={choices.url} aria-label="URL"
          placeholder="https://api.example.com/find?domain={{domain}}"
          onChange={e => onChange({ ...choices, url: e.target.value })} />
      </div>
      <p className="text-xs text-gray-500">
        Fill values with {inputs.slice(0, 3).map(i => `{{${i.key}}}`).join(', ')}{inputs.length > 3 ? '…' : ''}; a
        saved API key with /its_name.
      </p>
      <div className="space-y-1">
        {headers.map(([k, v], n) => (
          <div key={n} className="flex gap-1">
            <input className="input w-1/3 text-xs" value={k} placeholder="Header" aria-label="Header name"
              onChange={e => setHeaders(headers.map((h, x) => (x === n ? [e.target.value, h[1]] : h)))} />
            <input className="input flex-1 text-xs font-mono" value={v} placeholder="Value" aria-label="Header value"
              onChange={e => setHeaders(headers.map((h, x) => (x === n ? [h[0], e.target.value] : h)))} />
            <button type="button" className="p-1 text-gray-400 hover:text-gray-700" aria-label="Remove header"
              onClick={() => setHeaders(headers.filter((_, x) => x !== n))}><X className="h-3 w-3" /></button>
          </div>
        ))}
        <button type="button" className="text-xs text-gray-600 underline hover:no-underline flex items-center gap-0.5"
          onClick={() => setHeaders([...headers, ['', '']])}><Plus className="h-3 w-3" /> Header</button>
      </div>
      {hasBody && (
        <textarea className="input w-full h-20 font-mono text-xs" value={choices.body ?? ''} aria-label="Body"
          placeholder='{"domain": "{{domain}}"}'
          onChange={e => onChange({ ...choices, body: e.target.value || null })} />
      )}
      <label className="block space-y-1">
        <span className="meta-label">The value in its answer (JSONPath)</span>
        <input className="input w-full font-mono text-xs" value={choices.valuePath} aria-label="Value path"
          placeholder="$.data.email" onChange={e => onChange({ ...choices, valuePath: e.target.value })} />
      </label>
    </div>
  )
}

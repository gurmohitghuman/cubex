import React from 'react'
import { Key, Minus, Plus } from 'lucide-react'
import { HTTPAPIConfig } from './types'

// The request field groups, restacked to a single column for the narrow Clay-style
// accordion drawer (~512px). Each export is the BODY of one AccordionSection; the
// section chrome (title, chevron, summary) lives in ConfigureStep. Method sits above
// Endpoint (was a md:grid-cols-4 row); param/header rows are Key-over-Value blocks
// (were side-by-side flex inputs that truncated long /column_name + token values).

interface RequestProps {
  config: HTTPAPIConfig
  errors: Record<string, string>
  updateConfig: (updates: Partial<HTTPAPIConfig>) => void
  addQueryParam: () => void
  removeQueryParam: (i: number) => void
  updateQueryParam: (i: number, field: 'key' | 'value', value: string) => void
  addHeader: () => void
  removeHeader: (i: number) => void
  updateHeader: (i: number, field: 'key' | 'value', value: string) => void
  handleInputChange: (value: string, targetId: string, updateFn: () => void) => void
  handleSuggestionKeyDown: (e: React.KeyboardEvent, targetId: string) => void
}

export function MasterColumnField({ masterColumnName, setMasterColumnName, errors }: {
  masterColumnName: string
  setMasterColumnName: (v: string) => void
  errors: Record<string, string>
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">Master Column Name *</label>
      <input
        type="text"
        value={masterColumnName}
        onChange={(e) => setMasterColumnName(e.target.value)}
        placeholder="e.g., Email Verification, Company Lookup"
        className={`input w-full ${errors.masterColumnName ? '!border-red-300' : ''}`}
      />
      {errors.masterColumnName && <p className="text-sm text-cube-black mt-1">{errors.masterColumnName}</p>}
      <p className="text-xs text-gray-500 mt-1">
        This master column will show run status and allow individual row re-runs
      </p>
    </div>
  )
}

export function MethodEndpointFields({ config, errors, updateConfig, handleInputChange, handleSuggestionKeyDown }: RequestProps) {
  return (
    <>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Method *</label>
        <select className="input w-full" value={config.method}
          onChange={(e) => updateConfig({ method: e.target.value as any })}>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="DELETE">DELETE</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Endpoint URL *</label>
        <input type="text"
          className={`input w-full ${errors.endpointUrl ? '!border-red-300' : ''}`}
          placeholder="https://api.example.com/data"
          value={config.endpointUrl}
          onChange={(e) => handleInputChange(e.target.value, 'endpointUrl', () => updateConfig({ endpointUrl: e.target.value }))}
          onKeyDown={(e) => handleSuggestionKeyDown(e, 'endpointUrl')}
        />
        {errors.endpointUrl && <p className="text-xs text-cube-black mt-1">{errors.endpointUrl}</p>}
        <p className="text-xs text-gray-500 mt-1">Use /column_name or /api_key_name to reference columns and API keys</p>
      </div>
    </>
  )
}

export function QueryParamsFields({ config, addQueryParam, removeQueryParam, updateQueryParam, handleInputChange, handleSuggestionKeyDown }: RequestProps) {
  return (
    <>
      <div className="flex items-center justify-end">
        <button onClick={addQueryParam} className="text-xs text-cube-black hover:text-gray-700 flex items-center space-x-1">
          <Plus className="h-3 w-3" /><span>Add</span>
        </button>
      </div>
      {config.queryParams.length === 0 && <p className="text-xs text-gray-400">No query parameters.</p>}
      {config.queryParams.map((param, index) => (
        <div key={index} className="flex flex-col gap-2 border border-gray-200 rounded p-2">
          <input type="text" className="input w-full" placeholder="key" value={param.key}
            onChange={(e) => updateQueryParam(index, 'key', e.target.value)} />
          <div className="flex items-center gap-2">
            <input type="text" className="input flex-1"
              placeholder="value (supports /column_name or /api_key_name)"
              value={param.value}
              onChange={(e) => handleInputChange(e.target.value, `queryParam_${index}`, () => updateQueryParam(index, 'value', e.target.value))}
              onKeyDown={(e) => handleSuggestionKeyDown(e, `queryParam_${index}`)}
            />
            <button onClick={() => removeQueryParam(index)} className="p-2 text-gray-400 hover:text-cube-black flex-shrink-0">
              <Minus className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

export function HeadersFields({ config, updateConfig, addHeader, removeHeader, updateHeader, handleInputChange, handleSuggestionKeyDown }: RequestProps) {
  return (
    <>
      <div className="flex items-center justify-end gap-2">
        <button onClick={() => updateConfig({ headers: [...config.headers, { key: 'Authorization', value: 'Bearer ' }] })}
          className="text-xs text-gray-600 hover:text-gray-700 flex items-center space-x-1"
          title="Add Authorization Bearer token">
          <Key className="h-3 w-3" /><span>Auth</span>
        </button>
        <button onClick={addHeader} className="text-xs text-cube-black hover:text-gray-700 flex items-center space-x-1">
          <Plus className="h-3 w-3" /><span>Add</span>
        </button>
      </div>
      {config.headers.length === 0 && <p className="text-xs text-gray-400">No headers.</p>}
      {config.headers.map((header, index) => (
        <div key={index} className="flex flex-col gap-2 border border-gray-200 rounded p-2">
          <input type="text" className="input w-full" placeholder="Header-Name" value={header.key}
            onChange={(e) => updateHeader(index, 'key', e.target.value)} />
          <div className="flex items-center gap-2">
            <input type="text"
              className={`input flex-1 ${header.key.toLowerCase().includes('authorization') ? 'font-mono text-xs' : ''}`}
              placeholder={header.key.toLowerCase().includes('authorization') ? 'Bearer your-token-here' : 'value (supports /column_name or /api_key_name)'}
              value={header.value}
              onChange={(e) => handleInputChange(e.target.value, `header_${index}`, () => updateHeader(index, 'value', e.target.value))}
              onKeyDown={(e) => handleSuggestionKeyDown(e, `header_${index}`)}
            />
            <button onClick={() => removeHeader(index)} className="p-2 text-gray-400 hover:text-cube-black flex-shrink-0">
              <Minus className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

export function BodyField({ config, errors, updateConfig, handleInputChange, handleSuggestionKeyDown }: RequestProps) {
  return (
    <div>
      <textarea className={`input w-full h-32 resize-none font-mono text-sm ${errors.body ? '!border-red-300' : ''}`}
        placeholder='{"key": "/column_name", "auth": "/api_key_name"}'
        value={config.body}
        onChange={(e) => handleInputChange(e.target.value, 'body', () => updateConfig({ body: e.target.value }))}
        onKeyDown={(e) => handleSuggestionKeyDown(e, 'body')}
      />
      {errors.body && <p className="text-xs text-cube-black mt-1">{errors.body}</p>}
      <p className="text-xs text-gray-500 mt-1">
        JSON body supports /column_name and /api_key_name tokens. Ensure valid JSON after substitution.
      </p>
    </div>
  )
}

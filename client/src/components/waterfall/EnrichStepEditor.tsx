import React, { useEffect, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { enrichAPI, type EnrichToolCard, type EnrichToolDetail } from '@/utils/api'
import type { EnrichmentChoices, ResultType } from '@/utils/api/waterfall'
import type { DraftInput } from './draft'
import { asStepTool, defaultPath, toolLine } from './step-copy'

interface Props {
  choices: EnrichmentChoices
  toolName?: string
  inputs: DraftInput[]
  resultType: ResultType
  onChange: (choices: EnrichmentChoices, toolName?: string) => void
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// An enrichment step: a treg tool (searched like the Enrichment drawer's
// Find), its inputs read from the waterfall's (same names by default), and the
// answer field that holds the value (by default the one the result type names).
export const EnrichStepEditor: React.FC<Props> = ({ choices, toolName, inputs, resultType, onChange }) => {
  const [query, setQuery] = useState('')
  const [cards, setCards] = useState<EnrichToolCard[] | null>(null)
  const [tool, setTool] = useState<EnrichToolDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const picking = !choices.toolId

  useEffect(() => {
    if (!picking) return
    const ctl = new AbortController()
    const t = setTimeout(() => {
      enrichAPI.tools(query.trim(), ctl.signal)
        // A job that adds rows can't be a step; a preset card is its plain tool here.
        .then(r => setCards(r.tools.filter(c => !c.addsRows).map(asStepTool)))
        .catch(e => { if (!ctl.signal.aborted) setError(errorOf(e, "Couldn't search treg's tools.")) })
    }, 250)
    return () => { clearTimeout(t); ctl.abort() }
  }, [query, picking])

  useEffect(() => {
    if (picking) { setTool(null); return }
    let alive = true
    enrichAPI.tool(choices.toolId).then(t => { if (alive) setTool(t) })
      .catch(e => { if (alive) setError(errorOf(e, "Couldn't load the tool.")) })
    return () => { alive = false }
  }, [choices.toolId, picking])

  if (picking) {
    return (
      <div className="space-y-2" data-testid="waterfall-tool-search">
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2 top-2.5 text-gray-400" />
          <input className="input w-full pl-7" value={query} placeholder="Search treg's tools, e.g. work email"
            aria-label="Search tools" onChange={e => setQuery(e.target.value)} />
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        {!cards && !error && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
        <ul className="divide-y divide-gray-100 border border-gray-200 max-h-60 overflow-y-auto">
          {(cards ?? []).map(c => (
            <li key={`${c.id}:${c.preset ?? ''}`}>
              <button type="button" className="w-full text-left px-2 py-1.5 hover:bg-gray-50"
                onClick={() => onChange({ ...choices, toolId: c.id }, c.title)}>
                <span className="text-sm text-gray-900">{c.title}</span>
                <span className="block text-xs text-gray-500">{toolLine(c)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const keys = inputs.map(i => i.key)
  const mapped = (name: string) => {
    const src = choices.inputs[name]
    if (src === undefined) return keys.includes(name) && Object.keys(choices.inputs).length === 0 ? `k:${name}` : ''
    return typeof src === 'string' ? `k:${src}` : 'fixed'
  }
  const setInput = (name: string, v: string, fixed = '') => {
    const next = { ...choices.inputs }
    // The first change writes the whole map, so the same-name defaults stay as they were.
    if (Object.keys(next).length === 0 && tool) {
      for (const i of tool.inputs) if (keys.includes(i.name)) next[i.name] = i.name
    }
    if (!v) delete next[name]
    else next[name] = v === 'fixed' ? { value: fixed } : v.slice(2)
    onChange({ ...choices, inputs: next })
  }
  return (
    <div className="space-y-3" data-testid="waterfall-tool">
      <p className="text-sm text-gray-900 flex items-center justify-between gap-2">
        <span>{toolName ?? tool?.name ?? choices.toolId}</span>
        <button type="button" className="text-xs text-gray-600 underline hover:no-underline"
          onClick={() => onChange({ ...choices, toolId: '', inputs: {}, valuePath: null })}>Change tool</button>
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!tool ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : (
        <>
          <div className="space-y-1.5">
            <p className="meta-label">Its inputs</p>
            {tool.inputs.filter(i => !i.filter).map(i => {
              const v = mapped(i.name)
              const fixed = choices.inputs[i.name]
              return (
                <div key={i.name} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-2 items-center">
                  <span className="text-xs text-gray-600 font-mono break-words">{i.name}</span>
                  <div className="space-y-1">
                    <select className="input w-full" value={v} aria-label={`Tool input ${i.name}`}
                      onChange={e => setInput(i.name, e.target.value)}>
                      <option value="">Not used</option>
                      {inputs.map(x => <option key={x.key} value={`k:${x.key}`}>{x.label}</option>)}
                      <option value="fixed">A fixed value…</option>
                    </select>
                    {v === 'fixed' && typeof fixed === 'object' && (
                      <input className="input w-full" value={fixed.value} aria-label={`${i.name} value`}
                        onChange={e => setInput(i.name, 'fixed', e.target.value)} />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <label className="block space-y-1">
            <span className="meta-label">Answer field</span>
            <select className="input w-full" value={choices.valuePath ?? ''} aria-label="Answer field"
              onChange={e => onChange({ ...choices, valuePath: e.target.value || null })}>
              <option value="">{`Default (${defaultPath(resultType, tool.outputs) ?? 'none fits: pick one'})`}</option>
              {tool.outputs.map(o => <option key={o.path} value={o.path}>{o.field}</option>)}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="meta-label">Most a row may cost here (optional)</span>
            <input className="input w-32" type="number" min={0} step="0.001" value={choices.maxCostUsd ?? ''}
              aria-label="Step max cost" placeholder="Default"
              onChange={e => onChange({ ...choices, maxCostUsd: e.target.value ? Number(e.target.value) : null })} />
          </label>
        </>
      )}
    </div>
  )
}

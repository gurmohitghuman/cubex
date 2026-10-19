import React, { useEffect, useState } from 'react'
import {
  aiAPI, DEFAULT_SEARCH_MODE, SEARCH_MODES,
  type SearchEngine, type SearchPlanResponse, type WebSearchSettings,
} from '@/utils/api'
import { Select } from '../ui/Select'
import { MAX_SEARCHES_PER_ROW } from '@/lib/constants'

// Under "Web search": which engine the searches run on, its mode, and a limit
// on searches per row, with what that costs. The server works out the plan
// (GET /ai/search-plan, the same one a preview and a run get), so the line
// under the menus says what will really run and what a search costs.

const CAPS = Array.from({ length: MAX_SEARCHES_PER_ROW }, (_, i) => i + 1)
const MODE_NAMES: Record<string, string> = {
  instant: 'Instant', fast: 'Fast', auto: 'Auto', 'deep-lite': 'Deep lite', deep: 'Deep',
  'deep-reasoning': 'Deep reasoning', turbo: 'Turbo', basic: 'Basic', advanced: 'Advanced',
}
const usd = (n: number) => `$${Number(n.toPrecision(3))}`
const hasModes = (e: SearchEngine): e is 'exa' | 'parallel' => e === 'exa' || e === 'parallel'

interface Props {
  model: string
  value: WebSearchSettings
  onChange: (v: WebSearchSettings) => void
  // Why this choice can't run (null when it can), so the drawer can say why
  // "Try on rows" is off.
  onBlocked: (reason: string | null) => void
}

export const WebSearchOptions: React.FC<Props> = ({ model, value, onChange, onBlocked }) => {
  const [info, setInfo] = useState<SearchPlanResponse | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  // From a change until its plan arrives, the note still describes the old choice.
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!model) { setInfo(null); onBlocked(null); return }
    let live = true
    setPending(true)
    // Debounced, so stepping through the menus doesn't send a request each time.
    const timer = setTimeout(() => {
      aiAPI.searchPlan({ model, engine: value.engine, mode: value.mode, cap: value.maxPerRow })
        .then(r => { if (live) { setInfo(r); setUnreachable(false); onBlocked(r.error) } })
        .catch(() => { if (live) { setInfo(null); setUnreachable(true); onBlocked(null) } })
        .finally(() => { if (live) setPending(false) })
    }, 200)
    return () => { live = false; clearTimeout(timer) }
  }, [model, value.engine, value.mode, value.maxPerRow]) // eslint-disable-line react-hooks/exhaustive-deps

  const engine = value.engine
  const prices = hasModes(engine) ? info?.prices[engine] : undefined
  const modeLabel = (mode: string) => {
    const price = prices?.find(p => p.mode === mode)?.price
    return price != null ? `${MODE_NAMES[mode] ?? mode}, ${usd(price)}` : MODE_NAMES[mode] ?? mode
  }
  const native = info?.native
  const set = (patch: Partial<WebSearchSettings>) => onChange({ ...value, ...patch })

  return (
    <div className="mt-2 ml-6 space-y-2">
      <label className="block">
        <span className="block text-xs text-gray-600 mb-1">Search engine</span>
        <Select<SearchEngine> className="w-full" value={engine} label="Search engine"
          onChange={e => set({ engine: e, mode: '' })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'native', label: native?.available ? `${native.provider}'s own search` : "Model's own search" },
            { value: 'exa', label: 'Exa' },
            { value: 'parallel', label: 'Parallel' },
            { value: 'perplexity',
              label: info?.prices.perplexity != null ? `Perplexity, ${usd(info.prices.perplexity)}` : 'Perplexity' },
          ]} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block min-w-0">
          <span className="block text-xs text-gray-600 mb-1">Mode</span>
          <Select<string> className="w-full" value={value.mode} disabled={!hasModes(engine)} label="Mode"
            onChange={mode => set({ mode })}
            options={hasModes(engine) ? [
              { value: '', label: `Default (${modeLabel(DEFAULT_SEARCH_MODE[engine])})` },
              ...SEARCH_MODES[engine].map(m => ({ value: m as string, label: modeLabel(m) })),
            ] : [{ value: '', label: 'Not used' }]} />
        </label>
        <label className="block min-w-0">
          <span className="block text-xs text-gray-600 mb-1">Searches per row</span>
          <Select<string | number> className="w-full" value={value.maxPerRow ?? ''} label="Searches per row"
            onChange={v => set({ maxPerRow: v ? Number(v) : null })}
            options={[{ value: '', label: 'No limit' }, ...CAPS.map(n => ({ value: n, label: `Up to ${n}` }))]} />
        </label>
      </div>
      {info?.error && <p className="text-xs text-red-600" role="alert">{info.error}</p>}
      <div aria-live="polite">
        {!info?.error && info?.plan && (
          <p className={`text-xs text-gray-500${pending ? ' opacity-50' : ''}`} data-testid="web-search-plan">{info.plan.note}</p>
        )}
        {!info && unreachable && (
          <p className="text-xs text-gray-500">Couldn&apos;t check search prices right now. Try a few rows to see what a row costs.</p>
        )}
      </div>
    </div>
  )
}

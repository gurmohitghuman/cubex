import React, { useEffect, useState } from 'react'
import {
  aiAPI, DEFAULT_SEARCH_MODE, SEARCH_MODES,
  type SearchEngine, type SearchPlanResponse, type WebSearchSettings,
} from '@/utils/api'
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
        <select className="input w-full" value={engine} aria-label="Search engine"
          onChange={(e) => set({ engine: e.target.value as SearchEngine, mode: '' })}>
          <option value="auto">Auto</option>
          <option value="native">{native?.available ? `${native.provider}'s own search` : "Model's own search"}</option>
          <option value="exa">Exa</option>
          <option value="parallel">Parallel</option>
          <option value="perplexity">{info?.prices.perplexity != null ? `Perplexity, ${usd(info.prices.perplexity)}` : 'Perplexity'}</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block min-w-0">
          <span className="block text-xs text-gray-600 mb-1">Mode</span>
          <select className="input w-full !px-2" value={value.mode} disabled={!hasModes(engine)} aria-label="Mode"
            onChange={(e) => set({ mode: e.target.value })}>
            {hasModes(engine) ? (
              <>
                <option value="">Default ({modeLabel(DEFAULT_SEARCH_MODE[engine])})</option>
                {SEARCH_MODES[engine].map(m => <option key={m} value={m}>{modeLabel(m)}</option>)}
              </>
            ) : <option value="">Not used</option>}
          </select>
        </label>
        <label className="block min-w-0">
          <span className="block text-xs text-gray-600 mb-1">Searches per row</span>
          <select className="input w-full !px-2" value={value.maxPerRow ?? ''} aria-label="Searches per row"
            onChange={(e) => set({ maxPerRow: e.target.value ? Number(e.target.value) : null })}>
            <option value="">No limit</option>
            {CAPS.map(n => <option key={n} value={n}>Up to {n}</option>)}
          </select>
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

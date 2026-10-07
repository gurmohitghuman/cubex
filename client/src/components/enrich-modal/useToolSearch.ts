import { useEffect, useState } from 'react'
import { enrichAPI, type EnrichToolCard } from '@/utils/api'

const SEARCH_DEBOUNCE_MS = 300
const CACHE_MAX = 30
// Answers per query for this page session, so going back to Find or
// retyping a word shows its results at once (the server caches treg too).
const cache = new Map<string, EnrichToolCard[]>()

function remember(q: string, tools: EnrichToolCard[]) {
  cache.delete(q)
  cache.set(q, tools)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
}

interface SearchState { shownFor: string; tools: EnrichToolCard[] | null; loading: boolean; error: string | null }

// No query: the Popular jobs. A query searches treg's catalog, debounced; the
// last results stay on screen while the next ones load.
export function useToolSearch(query: string, active: boolean) {
  const q = query.trim()
  const [state, setState] = useState<SearchState>(() => ({ shownFor: q, tools: cache.get(q) ?? null, loading: false, error: null }))
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!active) return
    const hit = cache.get(q)
    if (hit) { setState({ shownFor: q, tools: hit, loading: false, error: null }); return }
    setState(s => ({ ...s, loading: true, error: null }))
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      enrichAPI.tools(q, ctrl.signal)
        .then(res => { remember(q, res.tools); setState({ shownFor: q, tools: res.tools, loading: false, error: null }) })
        .catch(err => {
          if (ctrl.signal.aborted) return
          const message = err?.response?.data?.error || "Couldn't load enrichments. Check your connection and try again."
          setState(s => ({ ...s, loading: false, error: message }))
        })
    }, q ? SEARCH_DEBOUNCE_MS : 0)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [q, active, attempt])

  return { ...state, retry: () => setAttempt(a => a + 1) }
}

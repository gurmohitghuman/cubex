import { useEffect, useState } from 'react'
import { enrichAPI, type EnrichToolCard } from '@/utils/api'
import { useTypedReads } from '@/hooks/useTypedReads'
import { readError } from '@/lib/typedReads'

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

// No query: the Popular jobs, at once. A query searches treg's catalog as it
// is typed: one read at a time, an older answer never shown
// (lib/typedReads.ts); the last results stay on screen while the next ones
// load.
export function useToolSearch(query: string, active: boolean) {
  const q = query.trim()
  const [state, setState] = useState<SearchState>(() => ({ shownFor: q, tools: cache.get(q) ?? null, loading: false, error: null }))
  const [attempt, setAttempt] = useState(0)
  const ask = useTypedReads<{ q: string; tools: EnrichToolCard[] }>(a => {
    if (a.ok) {
      remember(a.value.q, a.value.tools)
      setState({ shownFor: a.value.q, tools: a.value.tools, loading: false, error: null })
      return
    }
    const message = readError(a.error, "Couldn't load enrichments. Check your connection and try again.")
    setState(s => ({ ...s, loading: false, error: message }))
  })

  useEffect(() => {
    if (!active) return
    const hit = cache.get(q)
    if (hit) { setState({ shownFor: q, tools: hit, loading: false, error: null }); ask(q, null); return }
    setState(s => ({ ...s, loading: true, error: null }))
    ask(`${q}\n${attempt}`, signal => enrichAPI.tools(q, signal).then(res => ({ q, tools: res.tools })),
      q ? undefined : 0)
  }, [q, active, attempt, ask])

  return { ...state, retry: () => setAttempt(a => a + 1) }
}

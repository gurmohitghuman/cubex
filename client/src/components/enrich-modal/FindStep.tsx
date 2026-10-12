import React, { useEffect, useRef } from 'react'
import { Loader2, Search, X } from 'lucide-react'
import type { EnrichToolCard } from '@/utils/api'
import { TregNotice } from '../TregNotice'
import { TregLogo } from '../TregLogo'
import { LoadingSpinner } from '../LoadingSpinner'
import { ToolCard } from './ToolCard'
import { useToolSearch } from './useToolSearch'

interface Props {
  query: string
  setQuery: (q: string) => void
  hasKey: boolean | undefined
  active: boolean
  onPick: (card: EnrichToolCard) => void
}

const Group: React.FC<{ title: string; tools: EnrichToolCard[]; onPick: Props['onPick'] }> = ({ title, tools, onPick }) =>
  tools.length === 0 ? null : (
    <section>
      <h3 className="meta-label mb-1.5">{title}</h3>
      <div className="border border-gray-200 divide-y divide-gray-200">
        {tools.map(t => <ToolCard key={`${t.id}:${t.preset ?? ''}`} card={t} onPick={onPick} />)}
      </div>
    </section>
  )

// Step 1: pick what to find. No query lists the Popular jobs; typing searches
// treg's catalog, waterfalls first (they try providers for you).
export const FindStep: React.FC<Props> = ({ query, setQuery, hasKey, active, onPick }) => {
  const search = useToolSearch(query, active)
  const shown = search.tools ?? []
  const forQuery = search.shownFor
  // Focus without scrolling: the drawer is still off-screen while it slides in,
  // and a plain autoFocus scrolls it into view at once, so it pops in instead.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }) }, [])

  return (
    <div className="p-4 space-y-4">
      <TregNotice hasKey={hasKey} />
      <p className="flex items-center gap-1.5 text-xs text-gray-500" data-testid="treg-source">
        <TregLogo className="h-4 w-4" />
        Lookups run through treg.to, on your own treg key.
      </p>
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          className="input w-full pl-9 pr-16"
          placeholder="What do you want to find? For example: work email, phone"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
          aria-label="Search enrichments"
        />
        <span className="absolute right-2.5 top-2 flex items-center gap-1">
          {search.loading && search.tools && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="p-0.5 text-gray-400 hover:text-cube-black">
              <X className="h-4 w-4" />
            </button>
          )}
        </span>
      </div>

      {search.error ? (
        <div className="border border-gray-200 p-3 text-sm text-gray-700 space-y-2">
          <p>{search.error}</p>
          <button type="button" onClick={search.retry} className="btn-secondary">Try again</button>
        </div>
      ) : search.tools === null ? (
        <LoadingSpinner size="sm" message="Loading enrichments…" className="py-8" />
      ) : forQuery === '' ? (
        shown.length
          ? <Group title="Popular" tools={shown} onPick={onPick} />
          : <p className="text-sm text-gray-600">No Popular jobs to show right now. Search for what you want to find.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-gray-600">
          Nothing found for &quot;{forQuery}&quot;: treg has no tool that matches. Try other words, like &quot;company size&quot;
          or &quot;linkedin&quot;. For a provider treg doesn&apos;t carry, use an HTTP API column with your own key.
        </p>
      ) : (
        <div className="space-y-4">
          <Group title="Waterfalls (tries providers for you)" tools={shown.filter(t => t.kind === 'waterfall')} onPick={onPick} />
          <Group title="Single providers" tools={shown.filter(t => t.kind === 'single')} onPick={onPick} />
        </div>
      )}
    </div>
  )
}

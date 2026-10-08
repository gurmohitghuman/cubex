import React from 'react'
import { ChevronRight } from 'lucide-react'
import type { EnrichToolCard } from '@/utils/api'
import { cardMeta } from './copy'

// Square tags, like the rest of the drawer's badges.
export const Tag: React.FC<{ tone?: 'plain' | 'amber'; children: React.ReactNode }> = ({ tone = 'plain', children }) => (
  <span className={`px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap border ${
    tone === 'amber' ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-gray-300 bg-white text-gray-700'
  }`}>{children}</span>
)

// One enrichment in the Find list: what it does, then who runs it, the price
// and how often it works. Rows of one bordered list (divide-y in FindStep).
export const ToolCard: React.FC<{ card: EnrichToolCard; onPick: (card: EnrichToolCard) => void }> = ({ card, onPick }) => (
  <button
    type="button"
    onClick={() => onPick(card)}
    className="group w-full text-left px-3 py-2.5 hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50 flex items-start gap-2"
    data-testid="enrich-tool-card"
  >
    <div className="flex-1 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-gray-900">{card.title}</span>
        <span className="flex flex-wrap justify-end gap-1 flex-shrink-0">
          {card.addsRows && <Tag>Adds rows</Tag>}
          {card.needsOwnKey && <Tag tone="amber">Needs your own key at treg</Tag>}
        </span>
      </div>
      {card.blurb && <p className="text-xs text-gray-600 mt-0.5">{card.blurb}</p>}
      <p className="text-xs text-gray-500 mt-1">{cardMeta(card).join(' · ')}</p>
      {card.needsOwnKey && (
        <p className="text-xs text-amber-800 mt-1">
          {card.providerName ?? card.provider} isn&apos;t available on treg&apos;s key. Add your {card.providerName ?? card.provider} key at treg to use it.
        </p>
      )}
    </div>
    <ChevronRight className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-300 group-hover:text-cube-black" />
  </button>
)

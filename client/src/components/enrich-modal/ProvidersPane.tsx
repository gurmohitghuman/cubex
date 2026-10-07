import React, { useState } from 'react'
import type { EnrichToolAccess, EnrichToolDetail } from '@/utils/api'
import { formatCost } from '@/components/ai-modal/format'
import { inputLabel } from './labels'
import { providerCanAnswer } from './readiness'
import { dropProvider, moveProvider, orderRows, providerRows, type ProviderRow } from './providers'
import { ProviderItem, type ProviderState } from './ProviderItem'

interface Props {
  tool: EnrichToolDetail
  access: EnrichToolAccess | null
  order: string[]
  skip: string[]
  stopAtFirst: boolean
  sent: Set<string>
  update: (patch: { providerOrder?: string[]; skipProviders?: string[]; stopAtFirst?: boolean }) => void
}

// The waterfall's providers, as rows the user can switch off and reorder.
// treg always tries the team's own keys and free sources first, so those are
// pinned on top; the rest run in the order shown, cheapest first by default.
export function providerStates(p: Pick<Props, 'tool' | 'access' | 'order' | 'skip' | 'sent'>) {
  const rows = orderRows(providerRows(p.tool.providers ?? [], p.access), p.order)
  const known = new Set(p.tool.inputs.map(i => i.name))
  const skipped = new Set(p.skip.map(s => s.toLowerCase()))
  const stateOf = (r: ProviderRow): ProviderState => r.unavailable ? 'locked' : r.exhausted ? 'out'
    : !providerCanAnswer(r.accepts, p.sent, p.tool.derive, known) ? 'inputs'
      : skipped.has(r.provider.toLowerCase()) ? 'off' : 'on'
  return { rows, stateOf }
}

// "21 on · from $0.0048" for the accordion header.
export function providersSummary(rows: ProviderRow[], stateOf: (r: ProviderRow) => ProviderState): string {
  const on = rows.filter(r => stateOf(r) === 'on')
  if (on.length === 0) return 'None can run yet'
  const prices = on.map(r => r.usd).filter((u): u is number => u !== null)
  const from = prices.length ? Math.min(...prices) : null
  return `${on.length} on${from === null ? '' : from === 0 ? ' · from free' : ` · from ${formatCost(from)}`}`
}

export const ProvidersPane: React.FC<Props> = (p) => {
  const { rows, stateOf } = providerStates(p)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const pinned = rows.filter(r => r.access === 'own' || r.access === 'free')
  const ordered = rows.filter(r => !pinned.includes(r))
  const visible = ordered.map(r => r.provider)

  const setOrder = (next: string[]) => p.update({ providerOrder: [...pinned.map(r => r.provider), ...next] })
  const toggle = (r: ProviderRow) => {
    const lower = r.provider.toLowerCase()
    const off = p.skip.some(s => s.toLowerCase() === lower)
    p.update({ skipProviders: off ? p.skip.filter(s => s.toLowerCase() !== lower) : [...p.skip, r.provider] })
  }
  // The shortest identity a provider accepts, to say what it needs.
  const needs = (r: ProviderRow) => {
    const set = [...r.accepts].sort((a, b) => a.length - b.length)[0] ?? []
    return set.map(k => inputLabel(k, p.tool.capability)).join(' + ') || 'other inputs'
  }
  const item = (r: ProviderRow, movable: boolean, i: number) => (
    <ProviderItem key={r.provider} row={r} state={stateOf(r)} needs={needs(r)} movable={movable}
      first={i === 0} last={i === ordered.length - 1} dragOver={over === r.provider && dragging !== r.provider}
      onToggle={() => toggle(r)} onMove={d => setOrder(moveProvider(visible, r.provider, d))}
      drag={{
        onDragStart: () => setDragging(r.provider),
        onDragOver: e => { e.preventDefault(); setOver(r.provider) },
        onDrop: () => { if (dragging) setOrder(dropProvider(visible, dragging, r.provider)); setDragging(null); setOver(null) },
        onDragEnd: () => { setDragging(null); setOver(null) },
      }} />
  )

  return (
    <div className="space-y-3" data-testid="enrich-providers">
      {pinned.length > 0 && (
        <section>
          <h4 className="meta-label mb-1">Always first: your keys and free sources</h4>
          <ul className="border border-gray-200 divide-y divide-gray-100">{pinned.map((r, i) => item(r, false, i))}</ul>
        </section>
      )}
      <section>
        <h4 className="meta-label mb-1">{pinned.length ? 'Then in this order' : 'In this order'} (drag, or use the arrows)</h4>
        <ul className="border border-gray-200 divide-y divide-gray-100 max-h-80 overflow-y-auto">
          {ordered.map((r, i) => item(r, true, i))}
        </ul>
      </section>
      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={p.stopAtFirst} onChange={e => p.update({ stopAtFirst: e.target.checked })}
          className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" />
        <span>
          Stop after the first provider
          <span className="block text-xs text-gray-500">Only the first provider that can answer runs. Cheaper, but finds less.</span>
        </span>
      </label>
    </div>
  )
}

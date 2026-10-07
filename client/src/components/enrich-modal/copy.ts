// What cards and provider rows say about price and success (pure). Prices
// come live from treg's catalog; formatCost keeps sub-cent digits. Plain
// words, no em dashes.
import { formatCost } from '../ai-modal/format'
import { plural } from '../../lib/utils'
import type { EnrichToolCard, EnrichToolPrice } from '@/utils/api'
import type { ProviderRow } from './providers'

const pct = (rate: number) => `${Math.round(rate * 100)}%`

// treg's measured hit rate when it has one ("found 38% of the time"),
// else how often the tool answers without an error ("works 99% of the time").
export function rateText(o: { hitRate: number | null; okRate: number | null }): string | null {
  if (o.hitRate !== null) return `found ${pct(o.hitRate)} of the time`
  if (o.okRate !== null) return `works ${pct(o.okRate)} of the time`
  return null
}

const RESULT_UNITS: Record<string, string> = { keyword: 'keyword', page: 'page' }

// One call's price: "free", "$0.0050 when found", "$0.0089 per lookup", "$0.0010 per result".
export function priceText(price: EnrichToolPrice, needsOwnKey = false): string {
  if (price.type === 'free' || price.usd === 0) return 'free'
  if (price.usd === null) return needsOwnKey ? 'billed by your own provider key' : 'price not listed'
  const usd = formatCost(price.usd)
  if (price.type === 'per_success') return `${usd} when found`
  if (price.type === 'per_result') return `${usd} per ${RESULT_UNITS[price.unit ?? ''] ?? 'result'}`
  return `${usd} per lookup`
}

// The card's small print: waterfalls say how many providers and the cheapest
// price; single providers say who and what it costs; both add a success rate.
export function cardMeta(card: EnrichToolCard): string[] {
  const parts: string[] = []
  if (card.kind === 'waterfall') {
    // A Popular job's blurb says what it is; any other waterfall names its
    // platform ("LinkedIn"), since its job title alone can be vague.
    if (!card.blurb && card.platformLabel) parts.push(card.platformLabel)
    const n = card.childCount ?? 0
    parts.push(card.addsRows ? `pick 1 of ${plural(n, 'provider')}` : plural(n, 'provider'))
    const usd = card.price.usd
    parts.push(usd === null ? 'price varies' : usd === 0 ? 'from free' : `from ${formatCost(usd)}`)
  } else {
    parts.push(card.providerName ?? card.provider)
    parts.push(priceText(card.price, card.needsOwnKey))
  }
  const rate = rateText(card.observed)
  if (rate) parts.push(rate)
  return parts
}

// A waterfall provider's line: "$0.0048 when found · 30% found".
export function providerLine(row: ProviderRow): string {
  const price = row.usd === null ? 'price not listed'
    : row.usd === 0 ? 'free'
      : row.billsMisses ? `${formatCost(row.usd)} per try, found or not` : `${formatCost(row.usd)} when found`
  const rate = row.hitRate !== null ? `${pct(row.hitRate)} found` : row.works !== null ? `works ${pct(row.works)}` : null
  return rate ? `${price} · ${rate}` : price
}

export const ACCESS_TEXT: Record<'own' | 'connected' | 'free', string> = {
  own: 'your key, billed by the provider',
  connected: 'your connected account, billed by treg',
  free: 'free public source',
}

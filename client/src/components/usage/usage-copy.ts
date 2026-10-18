// The Usage view's words (pure): range and kind labels, money, the totals
// line and the notes under the table. Plain words, no em dashes.
import type { UsageFigures, UsageKind, UsageRangeName, UsageReport, UsageRow } from '@/utils/api'
import { plural } from '../../lib/utils'
import { formatCost } from '../ai-modal/format'

export const RANGE_LABELS: Record<UsageRangeName, string> = {
  this_week: 'This week', this_month: 'This month', last_week: 'Last week', last_month: 'Last month',
  custom: 'Pick days',
}

export const KIND_LABELS: Record<UsageKind, string> = {
  ai: 'AI', enrichment: 'Enrichment', http: 'HTTP API', mixed: 'Several kinds',
}

export const money = (v: number): string => (v === 0 ? '$0.00' : formatCost(v))

// A cell's cost can be a tiny fraction of a cent: two significant digits.
export function perCell(v: number | null): string {
  if (v === null) return ''
  if (v === 0) return '$0.00'
  if (v < 0.000001) return 'under $0.000001'
  return v < 0.0001 ? `$${Number(v.toPrecision(2))}` : formatCost(v)
}

export const columnName = (r: UsageRow): string => r.column ?? 'No column'

// "AI · deleted", "Enrichment".
export function columnMeta(r: UsageRow): string {
  return [r.kind ? KIND_LABELS[r.kind] : null, r.column_deleted ? 'deleted' : null].filter(Boolean).join(' · ')
}

export function totalsLine(t: UsageFigures): string {
  const per = t.cost_per_cell_usd === null ? '' : ` (${perCell(t.cost_per_cell_usd)} a cell)`
  return `${plural(t.runs, 'run')} · ${plural(t.cells, 'cell')} run · ${money(t.total_cost_usd)}${per}`
}

// What the total is made of, when more than one kind of cost is in it.
export function breakdownLine(t: UsageFigures): string | null {
  const parts = [
    t.ai_cost_usd > 0 ? `AI ${money(t.ai_cost_usd)}` : null,
    t.provider_cost_usd > 0 ? `your own AI provider key ${money(t.provider_cost_usd)}` : null,
    t.enrichment_cost_usd > 0 ? `enrichments ${money(t.enrichment_cost_usd)}` : null,
  ].filter((p): p is string => !!p)
  return parts.length > 1 ? `${parts.join(' · ')}.` : null
}

export function reusedLine(t: UsageFigures): string | null {
  if (t.reused_cells === 0) return null
  return `${plural(t.reused_cells, 'cell')} reused earlier answers, at no cost.`
}

export function truncatedLine(r: UsageReport): string | null {
  if (!r.truncated) return null
  const what = r.group_by === 'run' ? 'run' : r.group_by === 'day' ? 'day' : 'column'
  const first = r.group_by === 'column' ? 'costliest' : 'newest'
  return `Showing the ${first} ${r.rows.length.toLocaleString()} of ${plural(r.rows_total, what)}. `
    + 'The CSV has every one.'
}

export const rangeText = (r: UsageReport['range']): string => (r.from === r.to ? r.from : `${r.from} to ${r.to}`)

// A run's start, as stored (UTC, to the minute).
export const startedText = (at: string | undefined): string => (at ? at.slice(0, 16) : '')

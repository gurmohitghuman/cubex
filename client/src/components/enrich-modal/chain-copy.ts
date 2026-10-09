// The Run confirm's "Also runs" line (pure): the auto-runs a run sets off,
// from the server's estimate. In this sheet, the ones that read what the run
// writes (and what those write in turn); for a list job, the destination's
// auto-runs on the rows it adds.
import type { AutorunRowsEstimate } from '../../utils/api/types-autorun'
import { plural } from '../../lib/utils'
import { limitText, spent } from '../../lib/enrich-format'
import type { EnrichDraft } from './draft'

// The columns a run of this draft writes on its rows.
export function writtenColumns(d: EnrichDraft): string[] {
  const status = d.columnName.trim()
  if (d.list) return status ? [status] : []
  return [status, ...d.outputs.filter(o => o.enabled).map(o => o.columnName.trim())].filter(Boolean)
}

function what(a: AutorunRowsEstimate): string {
  if (a.pausedBy === 'user') return 'paused by you; it runs them when you resume it'
  const later = a.pausedBy === 'system' ? ', once its pause lifts' : ''
  if (a.kind === 'http') {
    return a.rows === 0 ? 'no requests left today' : `sends up to ${plural(a.rows, 'request')}${later}`
  }
  if (a.priceTimedOut) return `no estimate${later}`
  if (a.lowUsd === null || a.highUsd === null) return `your provider bills it${later}`
  const capped = a.dailyCapUsd !== null && a.highUsd > a.dailyCapUsd
    ? `, at most ${limitText(a.dailyCapUsd)} a day` : ''
  return `about ${spent(a.lowUsd)} to ${spent(a.highUsd)}${capped}${later}`
}

export function chainText(here: AutorunRowsEstimate[], dest?: { name: string; runs: AutorunRowsEstimate[] }): string {
  const list = (runs: AutorunRowsEstimate[]) => runs.map(a => `${a.column} (${what(a)})`).join(', ')
  const parts: string[] = []
  if (here.length) parts.push(`Also runs: ${list(here)}.`)
  if (dest?.runs.length) parts.push(`In ${dest.name}, the new rows also run: ${list(dest.runs)}.`)
  return parts.join(' ')
}

// What the confirm says while the list loads (its Run button waits for it).
export const CHAIN_LOADING = 'Checking what else this run sets off…'

// Clean data wording (pure): the toast once cleaning starts, and a clean
// column header's hover note. Plain words, no em dashes.
import { plural } from '../../lib/utils'
import { cleanerLabel } from '../../lib/cleaners'
import type { CleanColumnView, CleanStartResult } from '../../utils/api/clean'

// The server answers once the fill is done or after a few seconds: still
// filling ('busy'), done ('ok'), or the fill stopped ('error').
export function cleanStartedText(r: CleanStartResult): { text: string; tone: 'busy' | 'ok' | 'error' } {
  if (r.status === 'filling') return { text: `Cleaning ${r.column}…`, tone: 'busy' }
  if (r.status === 'failed') {
    return { text: `Couldn't clean ${r.column}. Try "Clean all rows again" from its menu.`, tone: 'error' }
  }
  return { text: `${r.column} is ready`, tone: 'ok' }
}

export interface CleanTip { label: string; text: string; problem: string | null }

// "Cleaned from Name (Full name) · 3 values it couldn't read are blank" (the
// header joins its auto-run note with another "·") and, when the last fill
// stopped, why (shown in amber).
export function cleanHeaderTip(v: CleanColumnView | undefined): CleanTip {
  if (!v) return { label: 'Clean data column', text: 'Clean data column', problem: null }
  const label = `Cleaned from ${v.source} (${cleanerLabel(v.cleaner)})`
  const parts = [label]
  if (v.status === 'filling') parts.push('Cleaning now')
  if (v.status === 'done' && v.blankRows > 0) {
    parts.push(`${plural(v.blankRows, 'value')} it couldn't read ${v.blankRows === 1 ? 'is' : 'are'} blank`)
  }
  const problem = v.status === 'failed'
    ? `Cleaning stopped${v.error ? `: ${v.error}` : ''}. Use "Clean all rows again" to try again.` : null
  return { label, text: parts.join(' · '), problem }
}

// Lookup column wording (pure): the toast once one is saved, its header's
// hover note, Edit lookup's notes, the default name, and what each kind of
// answer is called.
// Plain words, no em dashes.
import { plural } from '../../lib/utils'
import type { LookupColumnView, LookupReturns, LookupStartResult } from '../../utils/api/lookup'

export const RETURNS_LABEL: Record<LookupReturns, string> = {
  value: 'A column of the first match',
  exists: 'Yes or No',
  count: 'How many rows match',
  list: 'All matching rows, as a list',
}

// The server answers once the fill is done or after a few seconds.
export function lookupStartedText(r: LookupStartResult): { text: string; tone: 'busy' | 'ok' | 'error' } {
  if (r.status === 'filling') return { text: `Looking up ${r.column}…`, tone: 'busy' }
  if (r.status === 'failed') return { text: `${r.column} stopped. Open "Edit lookup" to see why.`, tone: 'error' }
  return { text: `${r.column} is ready`, tone: 'ok' }
}

// A name for the new column until the person types one.
export function defaultLookupName(returns: LookupReturns, otherSheet: string, returnColumn: string): string {
  if (!otherSheet) return ''
  if (returns === 'value') return returnColumn ? `${returnColumn} (${otherSheet})` : ''
  if (returns === 'exists') return `In ${otherSheet}`
  if (returns === 'count') return `Count in ${otherSheet}`
  return `${otherSheet} matches`
}

export interface LookupTip { label: string; text: string; problem: string | null }

// "Looks up Domain in Companies › Website · 3 rows show an error"; a lookup
// that stopped, or whose other sheet or column is gone, says why (in amber).
export function lookupHeaderTip(v: LookupColumnView | undefined): LookupTip {
  if (!v) return { label: 'Lookup column', text: 'Lookup column', problem: null }
  const where = v.otherSheet ? `${v.otherSheet} › ${v.matchColumn}` : 'a deleted sheet'
  const label = `Looks up ${v.sourceColumn} in ${where}${v.match === 'contains' ? ' (contains)' : ''}`
  const parts = [label]
  if (v.status === 'filling') parts.push(v.waiting ?? 'Looking up now')
  if (v.pausedRun) parts.push(v.pausedRun)
  if (v.keptChanging) parts.push(v.keptChanging)
  if (v.status === 'done' && v.errorRows > 0) {
    parts.push(`${plural(v.errorRows, 'row')} ${v.errorRows === 1 ? 'shows' : 'show'} an error`)
  }
  const problem = v.broken ? `${v.broken} Edit the lookup to set it up again.`
    : v.status === 'failed' ? `It stopped${v.error ? `: ${v.error}` : ''}. Edit the lookup to try again.` : null
  return { label, text: parts.join(' · '), problem }
}

// Edit lookup: why it stopped (the other sheet or a column gone, a failed
// fill), what a fill waits for, a paused run there it didn't wait for, a
// column there that kept changing while it filled, the first row that showed
// an error, and why auto-run is paused.
export function lookupNotes(view: LookupColumnView): string[] {
  return [
    view.broken ? `${view.broken} Pick the sheet and columns again.` : null,
    view.status === 'failed' && !view.broken ? `It stopped${view.error ? `: ${view.error}` : '.'}` : null,
    view.status === 'filling' && view.waiting ? view.waiting : null,
    view.pausedRun,
    view.keptChanging,
    view.status === 'done' && view.errorRows > 0
      ? `${view.errorRows === 1 ? '1 row shows' : `${view.errorRows} rows show`} an error.`
        + (view.firstError ? ` The first: ${view.firstError}` : '')
      : null,
    view.autoRunNote ? `Auto-run is paused: ${view.autoRunNote}` : null,
  ].filter((n): n is string => !!n)
}

// Formula column wording (pure): the toast once a formula column is saved,
// and its header's hover note. Plain words, no em dashes.
import { plural } from '../../lib/utils'
import type { FormulaColumnView, FormulaStartResult } from '../../utils/api/formula'

// The server answers once the fill is done or after a few seconds: still
// filling ('busy'), done ('ok'), or the fill stopped ('error').
export function formulaStartedText(r: FormulaStartResult): { text: string; tone: 'busy' | 'ok' | 'error' } {
  if (r.status === 'filling') return { text: `Working out ${r.column}…`, tone: 'busy' }
  if (r.status === 'failed') return { text: `${r.column} stopped. Open "Edit formula" to see why.`, tone: 'error' }
  return { text: `${r.column} is ready`, tone: 'ok' }
}

export interface FormulaTip { label: string; text: string; problem: string | null }

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// "Formula: {{Response}}?.emails… · 3 rows show an error" (the header joins
// its auto-run note with another "·") and, when the last fill stopped, why
// (shown in amber; a paused auto-run says so in its own note).
export function formulaHeaderTip(v: FormulaColumnView | undefined): FormulaTip {
  if (!v) return { label: 'Formula column', text: 'Formula column', problem: null }
  const label = `Formula: ${short(v.formula.replace(/\s+/g, ' '), 80)}`
  const parts = [label]
  if (v.status === 'filling') parts.push('Working it out now')
  if (v.status === 'done' && v.errorRows > 0) {
    parts.push(`${plural(v.errorRows, 'row')} ${v.errorRows === 1 ? 'shows' : 'show'} an error`)
  }
  const problem = v.status === 'failed'
    ? `It stopped${v.error ? `: ${v.error}` : ''}. Edit the formula to try again.` : null
  return { label, text: parts.join(' · '), problem }
}

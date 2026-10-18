// What the run dialog, the confirms and the progress say about rows that
// reuse a found answer an earlier run stored, at no cost (pure).
import type { EnrichReuseCount } from '@/utils/api'
import { plural } from '../../lib/utils'

const lastDays = (days: number) => (days === 1 ? 'the last day' : `the last ${days} days`)

// The estimate box: how many rows reuse, and that the figures are for the rest.
export function reuseEstimateLine(reuse: EnrichReuseCount | null, rows: number | null): string | null {
  if (!reuse || reuse.rows === 0 || rows === null) return null
  const others = Math.max(0, rows - reuse.rows)
  if (others === 0 && reuse.complete) {
    return `${rows === 1 ? 'This row reuses an answer' : `All ${plural(rows, 'row')} reuse answers`} found in `
      + `${lastDays(reuse.days)}, at no cost.`
  }
  const who = `${reuse.complete ? '' : 'At least '}${plural(reuse.rows, 'row')}`
  return `${who} ${reuse.rows === 1 ? 'reuses an answer' : 'reuse answers'} found in ${lastDays(reuse.days)}, `
    + `at no cost. The estimate covers the other ${plural(others, 'row')}.`
}

// One sentence for a confirm ('' when no row reuses).
export function reuseConfirmLine(rows: number, complete: boolean): string {
  if (rows === 0) return ''
  const verb = rows === 1 ? 'reuses an earlier answer' : 'reuse earlier answers'
  return ` ${complete ? '' : 'At least '}${plural(rows, 'row')} ${verb} at no cost.`
}

// Under "Always call again". days null: not read yet.
export function callAgainNote(days: number | null): string {
  if (days === 0) return 'Otherwise treg can answer a repeat lookup from its store, which can be cheaper.'
  const when = days === null ? 'recently' : `in ${lastDays(days)}`
  return `Otherwise a row whose lookup found something ${when} reuses that answer for free, `
    + 'and treg can answer other repeats from its store.'
}

// The run's progress.
export function reusedRunLine(rows: number): string {
  return `${plural(rows, 'row')} ${rows === 1 ? 'reused an earlier answer' : 'reused earlier answers'}, at no cost.`
}

// The Scheduled reruns drawer's cost line in words (ScheduleCost.tsx), from the column run estimates a run now would
// start (one for the add form; a table's schedule, one a sheet). Pure, so it is unit-tested.
import type { ColumnRunEstimate } from '../../utils/api/column-runs'

const plural = (n: number, one: string) => `${n.toLocaleString('en-US')} ${one}${n === 1 ? '' : 's'}`
// "nothing", "less than $0.01", "about $0.50", "about $0.10 to $0.40".
function price(low: number, high: number): string {
  if (high === 0) return 'nothing'
  if (high < 0.01) return 'less than $0.01'
  const [a, b] = [`$${low.toFixed(2)}`, `$${high.toFixed(2)}`]
  return `about ${a === b ? a : `${a} to ${b}`}`
}

// "A run now would cost about $0.10 to $0.40 for 120 rows." Rows: on each sheet, the most any column would run.
export function costWords(list: ColumnRunEstimate[]): string {
  const cols = list.flatMap(e => e.columns.filter(c => c.rows > 0))
  if (cols.length === 0) return 'A run now would find no rows to run.'
  const rows = list.reduce((n, e) => n + Math.max(0, ...e.columns.map(c => c.rows)), 0)
  const requests = cols.filter(c => c.sends_requests).reduce((n, c) => n + c.rows, 0)
  const priced = cols.some(c => !c.sends_requests && c.high_usd !== null)
  const low = list.reduce((n, e) => n + e.low_usd, 0)
  const high = list.reduce((n, e) => n + e.high_usd, 0)
  const unpriced = [...new Set(list.flatMap(e => e.unpriced))]
  const sends = `${plural(requests, 'request')} to your API, which Cubex has no price for`
  const words = priced
    ? `A run now would cost ${price(low, high)} for ${plural(rows, 'row')}`
      + (requests ? `, and send ${sends}.` : '.')
    : requests ? `A run now would send ${sends}.` : `A run now would run ${plural(rows, 'row')}.`
  const n = unpriced.length
  return n ? `${words} ${unpriced.join(', ')} ${n === 1 ? 'has' : 'have'} no price here.` : words
}

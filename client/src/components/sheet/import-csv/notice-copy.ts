// The import notice's words (pure): what the imported rows set off through
// each auto-run on the sheet (components/sheet/import-csv/ImportAutorunNotice).
import type { AutorunRowsEstimate } from '../../../utils/api/types-autorun'
import { plural } from '../../../lib/utils'
import { limitText, spent } from '../../../lib/enrich-format'
import { AUTORUN_HTTP_DEFAULT_DAILY_ROWS } from '../../../lib/constants'

export interface Count { rows: number; exact: boolean }

const these = (c: Count) => (!c.exact ? `these rows (about ${c.rows.toLocaleString()})`
  : c.rows === 1 ? 'this row' : `these ${plural(c.rows, 'row')}`)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function noticeLine(a: AutorunRowsEstimate, c: Count): string {
  const range = a.lowUsd !== null && a.highUsd !== null ? `about ${spent(a.lowUsd)} to ${spent(a.highUsd)}` : null
  const later = a.pausedBy === 'system' ? ' Its auto-run is paused now and fills them once it goes on.' : ''
  if (a.kind === 'http') {
    const most = `at most ${plural(a.dailyRowCap ?? AUTORUN_HTTP_DEFAULT_DAILY_ROWS, 'row')} a day`
    const sends = `sends a request for ${these(c)}${c.exact && c.rows === 1 ? '' : ', one per row'} (${most})`
    if (a.pausedBy === 'user') return `${a.column} is paused by you. When you resume it, it ${sends}.`
    return `${a.column} ${sends}.${later}`
  }
  if (a.pausedBy === 'user') {
    return `${a.column} is paused by you. When you resume it, it runs on ${these(c)} too${range ? `, ${range}` : ''}.`
  }
  const cost = range ? ` ${cap(these(c))} could cost ${range}.` : ' Your own provider key at treg bills these calls.'
  const capped = a.dailyCapUsd !== null && a.highUsd !== null && a.highUsd > a.dailyCapUsd
    ? ` Its ${limitText(a.dailyCapUsd)} daily cap stops it sooner; the rest runs on the next days.` : ''
  return `${a.column} runs on new rows automatically.${cost}${capped}${later}`
}

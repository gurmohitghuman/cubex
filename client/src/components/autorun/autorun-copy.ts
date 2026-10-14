// Auto-run wording (pure): the column header's tooltip, pause reasons, the
// sheet header's chip and the dialog. Plain words, no em dashes.
import { plural } from '../../lib/utils'
import { limitText, spent, utcMidnightLocal } from '../../lib/enrich-format'
import { AUTORUN_HTTP_DEFAULT_DAILY_ROWS } from '../../lib/constants'
import type {
  AutorunColumn, AutorunKind, AutorunPause, ColumnSpend, SheetAutorun,
} from '@/utils/api/types-autorun'

const SHORT: Record<AutorunPause, string> = {
  user: 'paused by you', column_cap: "this column's cap", row_cap: 'rows a day', daily_limit: 'the daily limit',
  no_key: 'no treg key', auth: 'treg key refused', balance: 'balance', treg_cap: "treg's limit",
  team_rule: 'treg team rule', provider_busy: 'provider busy', unreachable: "can't reach treg",
  unconfirmed: 'waiting on treg', retired: 'tool retired', missing_input: 'column missing',
  setup: 'needs a fix', failed: 'a run failed', queue: "couldn't queue", priced: 'needs a daily cap',
  dest_full: 'the sheet it adds to is full', loop: 'its rows would come back', too_slow: 'the formula is too slow',
}

export const pauseShort = (r: AutorunPause | null): string => (r ? SHORT[r] ?? 'paused' : '')

// "Paused by you" or "Paused: the daily limit" (chip panel, dialog banner).
export const pauseLabel = (r: AutorunPause | null): string =>
  (r === 'user' ? 'Paused by you' : `Paused: ${pauseShort(r)}`)

const CAPS = new Set<AutorunPause>(['column_cap', 'row_cap', 'daily_limit'])

// Why it is paused, in full: the server's words, and for today's caps when it
// goes on, in the reader's own time.
export function pauseSentence(a: Pick<AutorunColumn, 'pausedReason' | 'pausedMessage'>, now = new Date()): string {
  const words = a.pausedMessage ?? ''
  if (!a.pausedReason || !CAPS.has(a.pausedReason)) return words
  return `${words} It goes on after midnight UTC (${utcMidnightLocal(now)} your time).`.trim()
}

// What lifts a cap today instead of at midnight (the dialog says it).
export function capFix(r: AutorunPause | null): string | null {
  if (r === 'column_cap') return 'Raise the cap to go on today.'
  if (r === 'row_cap') return 'Raise the rows a day to go on today.'
  if (r === 'daily_limit') return 'Raise the daily limit in Settings to go on today.'
  return null
}

export function autorunUsage(a: AutorunColumn): string {
  // A clean data column's auto-run has no caps: it costs nothing and sends nothing.
  if (a.kind === 'clean') return 'cleans new and changed rows for free'
  if (a.kind === 'formula') return 'works out new and changed rows for free'
  if (a.kind === 'http') {
    return `${a.rowsToday.toLocaleString()} of ${plural(a.dailyRowCap ?? AUTORUN_HTTP_DEFAULT_DAILY_ROWS, 'row')} today`
  }
  return a.dailyCapUsd === null
    ? `${spent(a.usedTodayUsd)} used today`
    : `${spent(a.usedTodayUsd)} of ${limitText(a.dailyCapUsd)} used today`
}

export interface HeaderTipText { text: string; paused: string | null }

// The status column header's tooltip: what the column spent, then its auto-run
// ("Spent $9.40 on 1,204 rows · Auto-run on, $1.20 of $5.00 used today"), or
// why its auto-run is paused (shown in amber).
export function headerTip(spend: ColumnSpend | undefined, a: AutorunColumn | undefined): HeaderTipText | null {
  const parts: string[] = []
  if (spend) parts.push(`Spent ${spent(spend.spentUsd)} on ${plural(spend.rows, 'row')}`)
  const on = !!a?.enabled
  if (on && !a!.pausedReason) parts.push(`Auto-run on, ${autorunUsage(a!)}`)
  let paused: string | null = null
  if (on && a!.pausedReason === 'user') paused = 'Auto-run paused by you.'
  else if (on && a!.pausedReason) {
    paused = `Auto-run paused: ${pauseShort(a!.pausedReason)}. ${pauseSentence(a!)}`.trim()
  }
  return parts.length || paused ? { text: parts.join(' · '), paused } : null
}

export interface ChipState { label: string; tone: 'on' | 'amber' | 'muted' }

// The sheet header's chip: shown while any column has auto-run on.
export function chipState(view: SheetAutorun | undefined): ChipState | null {
  const on = Object.values(view?.columns ?? {}).filter(c => c.enabled)
  if (on.length === 0) return null
  const stopped = on.find(c => c.pausedReason && c.pausedReason !== 'user')
  if (stopped) {
    // On the sheet header "this column" has no referent: name it.
    const why = stopped.pausedReason === 'column_cap' ? `${stopped.column}'s cap`
      : stopped.pausedReason === 'row_cap' ? `${stopped.column}'s rows a day` : pauseShort(stopped.pausedReason)
    return { label: `Auto-run paused: ${why}`, tone: 'amber' }
  }
  const going = on.filter(c => !c.pausedReason).length
  if (going === 0) return { label: 'Auto-run paused', tone: 'muted' }
  if (on.length === 1) return { label: 'Auto-run on', tone: 'on' }
  const count = going === on.length ? `${on.length} columns` : `${going} of ${on.length} columns`
  return { label: `Auto-run on (${count})`, tone: 'on' }
}

// Turning auto-run on where a webhook adds rows: say who can add rows that spend.
// ownKey: the provider bills the tool on the team's own key, outside every limit here.
export function webhookWarning(kind: AutorunKind, dailyLimitUsd: number | null, ownKey = false): string {
  if (kind === 'clean') return "Anyone with this sheet's webhook URL can add rows. Each new row is cleaned, for free."
  if (kind === 'formula') {
    return "Anyone with this sheet's webhook URL can add rows. Each new row is worked out by the formula, for free."
  }
  if (kind === 'http') {
    return "Anyone with this sheet's webhook URL can add rows, and each new row sends this request. "
      + 'Your rows-a-day cap limits how many run.'
  }
  const cap = ownKey ? ' The provider bills each one on your own key, and no daily cap applies.'
    : dailyLimitUsd === null ? '' : ` Your daily limit (${limitText(dailyLimitUsd)}) caps the spend.`
  return `Anyone with this sheet's webhook URL can add rows, and each new row runs this column.${cap}`
}

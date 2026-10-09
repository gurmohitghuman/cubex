// Auto-run in the client (pure): the status column header's tooltip, the sheet
// header's chip, the webhook warning, and the CSV import's row count (quoted
// line breaks don't end a row). Value imports are relative (tsx has no "@/").
import {
  chipState, headerTip, pauseShort, webhookWarning,
} from '../../client/src/components/autorun/autorun-copy'
import { countCsvRows } from '../../client/src/components/sheet/import-csv/countCsvRows'
import { noticeLine } from '../../client/src/components/sheet/import-csv/notice-copy'
import { chainText } from '../../client/src/components/enrich-modal/chain-copy'
import type { AutorunColumn, AutorunRowsEstimate } from '../../client/src/utils/api/types-autorun'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const col = (o: Partial<AutorunColumn> = {}): AutorunColumn => ({
  column: 'Work email', kind: 'enrichment', enabled: true, pausedReason: null, pausedMessage: null, where: [],
  dailyCapUsd: 5, dailyRowCap: null, usedTodayUsd: 1.2, rowsToday: 3, ...o,
})

async function main() {
  const tip = headerTip({ spentUsd: 9.4, rows: 1204 }, col())
  check('tooltip: spend, then auto-run today',
    tip?.text === 'Spent $9.40 on 1,204 rows · Auto-run on, $1.20 of $5.00 used today')
  const message = "Today's $10.00 enrichment limit is reached."
  const paused = headerTip(undefined, col({ pausedReason: 'daily_limit', pausedMessage: message }))
  check('tooltip: the paused reason, apart (amber), with when it goes on in local time', paused?.text === ''
    && !!paused?.paused?.startsWith("Auto-run paused: the daily limit. Today's $10.00 enrichment limit is reached. "
      + 'It goes on after midnight UTC (') && paused.paused.endsWith(' your time).'))
  check('tooltip: paused by you',
    headerTip(undefined, col({ pausedReason: 'user' }))?.paused === 'Auto-run paused by you.')
  check('tooltip: an HTTP column counts rows', headerTip(undefined,
    col({ kind: 'http', dailyCapUsd: null, dailyRowCap: 500, rowsToday: 12 }))?.text
    === 'Auto-run on, 12 of 500 rows today')
  check('tooltip: nothing to say',
    headerTip(undefined, undefined) === null && headerTip(undefined, col({ enabled: false })) === null)

  check('no chip without auto-run on',
    chipState({ columns: { a: col({ enabled: false }) }, hasWebhook: false }) === null)
  check('chip: on', chipState({ columns: { a: col() }, hasWebhook: false })?.label === 'Auto-run on')
  check('chip: a stop shows its reason in amber', JSON.stringify(chipState({
    columns: { a: col(), b: col({ column: 'Push', pausedReason: 'row_cap' }) }, hasWebhook: false,
  })) === JSON.stringify({ label: "Auto-run paused: Push's rows a day", tone: 'amber' }))
  check('chip: one of two paused by you', chipState({
    columns: { a: col(), b: col({ column: 'Push', pausedReason: 'user' }) }, hasWebhook: false,
  })?.label === 'Auto-run on (1 of 2 columns)')
  check('chip: all paused by you is muted',
    chipState({ columns: { a: col({ pausedReason: 'user' }) }, hasWebhook: false })?.tone === 'muted')
  check('every pause reason has words', ['user', 'retired', 'missing_input', 'failed', 'unreachable']
    .every(r => pauseShort(r as never).length > 0))
  check('webhook warning names the daily limit',
    webhookWarning('enrichment', 10).endsWith('Your daily limit ($10.00) caps the spend.'))
  check('webhook warning for an HTTP column talks about requests',
    webhookWarning('http', 10).includes('sends this request'))
  check('own key: the webhook warning says no daily cap applies, not the limit',
    webhookWarning('enrichment', 10, true).endsWith('on your own key, and no daily cap applies.'))

  const csv = 'Name,Note\r\nAda,"two\nlines"\r\nGrace,ok\n\nAlan,"say ""hi"""'
  check('CSV rows: quoted line breaks and blank lines', (await countCsvRows(new Blob([csv]))).rows === 3)
  check('CSV rows: a header alone is none', (await countCsvRows(new Blob(['Name,Website\n']))).rows === 0)
  const big = new Blob(['Name,Website\n', ...Array.from({ length: 20000 }, (_, i) => `Person ${i},site${i}.com\n`)])
  const approx = await countCsvRows(big, 64 * 1024)
  check('CSV rows: a big file is scaled from its first part, about right (within 10%)', !approx.exact
    && Math.abs(approx.rows - 20000) < 2000)

  const est = { column: 'Work email', kind: 'enrichment' as const, rows: 300, lowUsd: 1.44, highUsd: 45,
    dailyCapUsd: 5, dailyRowCap: null, pausedBy: null }
  check('import notice: cost range, and the cap stops it sooner', noticeLine(est, { rows: 300, exact: true })
    === 'Work email runs on new rows automatically. These 300 rows could cost about $1.44 to $45.00.'
    + ' Its $5.00 daily cap stops it sooner; the rest runs on the next days.')
  check('import notice: paused by you, resuming runs them too',
    noticeLine({ ...est, pausedBy: 'user' }, { rows: 1, exact: true })
    === 'Work email is paused by you. When you resume it, it runs on this row too, about $1.44 to $45.00.')
  check('import notice: a big file says about',
    noticeLine({ ...est, dailyCapUsd: null }, { rows: 12000, exact: false })
      .includes('These rows (about 12,000) could cost about'))
  check('import notice: an HTTP column sends a request per row', noticeLine({ ...est, column: 'Push', kind: 'http',
    lowUsd: null, highUsd: null, dailyCapUsd: null, dailyRowCap: 50 }, { rows: 3, exact: true })
    === 'Push sends a request for these 3 rows, one per row (at most 50 rows a day).')

  // The Run confirm's "Also runs" line.
const chained = (o: Partial<AutorunRowsEstimate>): AutorunRowsEstimate => ({
  column: 'Verify email', kind: 'enrichment', rows: 1204, lowUsd: 0.2, highUsd: 2.4, dailyCapUsd: null,
  dailyRowCap: null, pausedBy: null, ...o,
})
check('nothing set off, no line', chainText([]) === '')
const push = chained({ column: 'Add to Smartlead', kind: 'http', lowUsd: null, highUsd: null })
check('a chain', chainText([chained({}), push])
  === 'Also runs: Verify email (about $0.200 to $2.40), Add to Smartlead (sends up to 1,204 requests).')
check('a cap below the range', chainText([chained({ dailyCapUsd: 1 })]).includes('at most $1.00 a day'))
check('paused by you',
  chainText([chained({ pausedBy: 'user' })]).includes('paused by you; it runs them when you resume it'))
check('own key',
  chainText([chained({ lowUsd: null, highUsd: null })]) === 'Also runs: Verify email (your provider bills it).')
check('no price in time',
  chainText([chained({ lowUsd: null, highUsd: null, priceTimedOut: true })]).includes('no estimate'))
check('a list job\'s destination', chainText([], { name: 'People', runs: [chained({ column: 'Find email' })] })
  === 'In People, the new rows also run: Find email (about $0.200 to $2.40).')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall auto-run client checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })

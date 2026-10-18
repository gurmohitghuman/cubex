// The enrichment drawer's run helpers (client/src/components/enrich-modal):
// the run request's rows (a new column takes every row, a continuing one the
// rows picked by status; test runs only on rows not run yet), "Edit
// enrichment" laying a column's choices over Set up's defaults, and the column
// menu's confirm words. Pure: no DB, no network. Value imports are relative
// (tsx has no "@/" alias), as in enrich-setup-client.test.ts.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import toolMod from '../../server/src/lib/enrich-tool'
import { emptyDraft } from '../../client/src/components/enrich-modal/draft'
import { buildSetup } from '../../client/src/components/enrich-modal/setup-defaults'
import { applyRecall } from '../../client/src/components/enrich-modal/recall'
import { canTest, quotedLimit, rowsPhrase, runRequest } from '../../client/src/components/enrich-modal/run-request'
import { RERUN_STATUS, rerunMessage } from '../../client/src/components/enrich-modal/rerun-copy'
import {
  callAgainNote, reuseConfirmLine, reuseEstimateLine, reusedRunLine,
} from '../../client/src/components/enrich-modal/reuse-copy'
const { normalizeTool } = toolMod as typeof import('../../server/src/lib/enrich-tool')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/treg', 'email-find.json'), 'utf8'))
const find: any = normalizeTool(fixture)
const card: any = {
  id: find.id, title: 'Verified work email', preset: 'verified_email', kind: 'waterfall', price: find.price,
}

// --- Run requests ------------------------------------------------------------
const fresh = { ...emptyDraft(), card, columnName: 'Work email', step: 'setup' as const }
const choice = { mode: 'all' as const, selectedRows: [], test: false, order: [] }
check('a new column takes every row', runRequest(fresh, choice)?.rows.status === 'any')
check('a new column can test', canTest(fresh))
const more = { ...fresh, continueColumn: 'Work email' }
check('adding to it takes the rows not enriched yet', runRequest(more, choice)?.rows.status === 'not_enriched')
check('the Test step asks for that explicitly',
  runRequest(more, { ...choice, status: 'not_enriched' })?.continueColumn === true)
const failed = { ...more, rowsStatus: 'failed' as const }
check('failed rows: no test run (it would re-buy the same rows)', !canTest(failed))
check('failed rows go out as such', runRequest(failed, choice)?.rows.status === 'failed')
const renamed = { ...failed, columnName: 'Work email 2' }
check('a renamed column is a new one again', runRequest(renamed, choice)?.rows.status === 'any' && canTest(renamed))
check('rows phrases', rowsPhrase(1199, 'not_enriched', true) === '1,199 rows not enriched yet'
  && rowsPhrase(12, 'failed', true) === '12 rows that failed' && rowsPhrase(40, 'any', true) === 'all 40 rows again'
  && rowsPhrase(5, 'any', false) === '5 rows')

// --- Edit enrichment ----------------------------------------------------------
const built = buildSetup(card, find, ['Name', 'Website', 'Work email', 'Email', 'Found by'], null)
const recalled = applyRecall(built, {
  toolId: find.id, toolName: 'Verified work email', preset: 'verified_email', columnName: 'Work email',
  inputs: { full_name: { column: 'Name' }, domain: { value: 'acme.example' } }, cleanDomains: false,
  providerOrder: ['tomba', 'nope'], skipProviders: ['wiza'], stopAtFirst: true,
  email: { accept: 'wide', guess: false, pattern: 'flast' },
  outputs: [
    { key: 'email', path: '$.output.email', columnName: 'Email' },
    { key: 'found_by', path: null, columnName: 'Found by' },
  ],
  conditions: [{ column: 'Website', op: 'not_empty', value: '' }], maxCostPerRowUsd: 0.04, fresh: true,
}, 'Work email')
check('it adds to the column, rows not enriched yet', recalled.continueColumn === 'Work email'
  && recalled.columnName === 'Work email' && recalled.rowsStatus === 'not_enriched')
check('inputs: a column and a fixed value', recalled.bindings?.full_name?.kind === 'column'
  && recalled.bindings?.domain?.kind === 'fixed' && !recalled.cleanDomains)
const order = recalled.providerOrder ?? []
check('its order first; an unknown provider dropped; the rest kept', order[0] === 'tomba' && !order.includes('nope')
  && order.length === (built.providerOrder ?? []).length)
check('email checks and switches come back', recalled.emailChecks?.accept === 'wide' && recalled.stopAtFirst === true
  && recalled.fresh === true && recalled.maxCostPerRowUsd === 0.04 && recalled.conditions?.length === 1)
const on = (recalled.outputs ?? []).filter(o => o.enabled).map(o => `${o.key}=${o.columnName}`)
check('its outputs on with their names, the rest off', on.join() === 'email=Email,found_by=Found by')
check('a new run limit (sized to the rows it takes)', recalled.spendLimitUsd === null && recalled.recall === null)

// --- Column menu confirm ------------------------------------------------------
const est = {
  column: 'Work email', toolName: 'Verified work email', rows: 12, reusedRows: 0, reuseComplete: true,
  priceKnown: true, lowUsd: 0.06, highUsd: 0.48,
  maxCostPerRowUsd: 0.04, spendLimitUsd: 0.48, dailyLimit: { limitUsd: 10, usedTodayUsd: 1, remainingUsd: 9 },
}
const msg = rerunMessage('failed', est)
check('failed rows: the count, replaced, the range, the stop, today',
  msg.startsWith('Run Verified work email on 12 rows that failed?')
  && msg.includes('replaced') && msg.includes('$0.060 to $0.480') && msg.includes('stops at $0.480')
  && msg.includes("Today's limit: $10.00, $9.00 left"))
check('not enriched yet: nothing is replaced', !rerunMessage('not_enriched', est).includes('replaced'))
check('nothing to run says so', rerunMessage('failed', { ...est, rows: 0 }) === 'No rows in Work email failed.')
check('one row reads as one', rerunMessage('selected', { ...est, rows: 1 }).includes('Its current result is replaced'))
check('the provider bills: no figures',
  rerunMessage('all', { ...est, priceKnown: false }).includes('bills these calls directly'))
const reusing = rerunMessage('all', { ...est, reusedRows: 5 })
check('rows that reuse earlier answers: said, not charged again, and how to call them again',
  reusing.includes('5 rows reuse earlier answers at no cost.') && !reusing.includes('each row costs again')
  && reusing.includes('turn on Always call again'))
check('... a floor says at least', rerunMessage('not_enriched', { ...est, reusedRows: 5, reuseComplete: false })
  .includes('At least 5 rows reuse'))

// --- Reuse in the run dialog ----------------------------------------------------
const count = (rows: number, complete = true) => ({ rows, checked: 12, complete, days: 30 })
check('the estimate says how many reuse and that it covers the rest',
  reuseEstimateLine(count(5), 12) === '5 rows reuse answers found in the last 30 days, at no cost. '
    + 'The estimate covers the other 7 rows.')
check('... every row reusing', reuseEstimateLine(count(12), 12)?.startsWith('All 12 rows reuse answers') === true)
check('... one row reads as one', reuseEstimateLine(count(1), 12)?.startsWith('1 row reuses an answer') === true)
check('... nothing when none reuse', reuseEstimateLine(count(0), 12) === null && reuseEstimateLine(null, 12) === null)
check('the confirm line', reuseConfirmLine(1, true) === ' 1 row reuses an earlier answer at no cost.'
  && reuseConfirmLine(0, true) === '')
check('Always call again names the days, or treg\'s store when reuse is off',
  callAgainNote(30).includes('in the last 30 days') && callAgainNote(0).includes("treg can answer a repeat lookup"))
check('the progress line', reusedRunLine(3) === '3 rows reused earlier answers, at no cost.')
const priced = (highUsd: number) => ({
  estimate: { rows: 3, lowUsd: 0, highUsd, perRowLowUsd: 0.01, perRowHighUsd: 0.05 }, defaultMaxCostPerRowUsd: 0.05,
} as never)
const plain = { spendLimitUsd: null }
check('the quoted limit is the high end', quotedLimit({ draft: plain, estimate: priced(0.15), unpriced: false }) === 0.15)
check('... one row more when rows reuse (an answer can go stale before the run)',
  Math.abs((quotedLimit({ draft: plain, estimate: priced(0.1), unpriced: false, reuse: count(1) }) ?? 0) - 0.15) < 1e-9)
check('... never $0 when every row reuses: the start sizes it then',
  quotedLimit({ draft: plain, estimate: { estimate: { rows: 0, lowUsd: 0, highUsd: 0, perRowLowUsd: 0,
    perRowHighUsd: 0 } } as never, unpriced: false, reuse: count(3) }) === null)
check('... the one typed wins', quotedLimit({ draft: { spendLimitUsd: 2 }, estimate: priced(0.1), unpriced: false }) === 2)

check('menu actions map to statuses', RERUN_STATUS.selected === 'any' && RERUN_STATUS.not_enriched === 'not_enriched')
const all = [msg, rerunMessage('all', est), rerunMessage('selected', est), reusing, reuseEstimateLine(count(5), 12),
  callAgainNote(30), callAgainNote(0)].join(' ')
check('no em dashes in the copy', !all.includes(String.fromCharCode(0x2014)))

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrichment run client checks passed')

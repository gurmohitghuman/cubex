// The app's "Raise the spend limit" dialog (client/src/components/ai-modal/raise-limit.ts):
// a new limit is checked against the least the server takes, in micro-dollars as
// the server compares (rounded), never as floats; its words show that least
// exactly, why the run paused, what the amount filled in covers, and the runs
// Resume all has still to ask about. Pure: no DB, no network. Value imports are
// relative (tsx has no "@/" alias).
import assert from 'node:assert/strict'
import ceilingMod from '../../server/src/lib/cost-ceiling'
import {
  leastLine, microOf, pauseLine, queuedLine, suggestLine, tooLow, tooLowLine,
} from '../../client/src/components/ai-modal/raise-limit'
import { limitText } from '../../client/src/lib/enrich-format'
import type { AiLimitView } from '../../client/src/utils/api/types-search'
const { micro } = ceilingMod as typeof import('../../server/src/lib/cost-ceiling')

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const view = (o: Partial<AiLimitView> = {}): AiLimitView => ({
  column_name: 'Fit (Output)', status: 'paused', pause_reason: 'spend_limit', message: null, limit_usd: 0.1,
  spent_usd: 0.05, cut_off_usd: 0, next_row_usd: 0.050001, least_usd: 0.100001, suggest_usd: 0.26, rows_left: 4,
  ...o,
})

check('a new limit compares in micro-dollars, rounded as the server rounds it', () => {
  const v = view()
  // 0.1000006 rounds to the least (100001 micro-dollars): the server takes it, so the dialog does.
  for (const ok of [0.100001, 0.1000006, 0.10000095, 0.2]) {
    assert.equal(tooLow(ok, v), false, String(ok))
    assert.ok(micro(ok) >= micro(v.least_usd), `the server takes ${ok}`)
  }
  // 1e-7 above the old limit rounds to it: the server refuses that, so the dialog does.
  for (const low of [0.1, 0.1000001, 0.1000004, 0.05]) {
    assert.equal(tooLow(low, v), true, String(low))
    assert.ok(micro(low) < micro(v.least_usd), `the server refuses ${low}`)
  }
  assert.equal(microOf(0.000001), 1)
})

check('the least shows exactly, to the micro-dollar, with what it is made of', () => {
  assert.equal(limitText(0.000001), '$0.000001')
  assert.equal(limitText(0.0125), '$0.0125')
  assert.equal(limitText(0.1), '$0.10')
  assert.equal(leastLine(view()),
    'It needs at least $0.100001 to go on: what it spent ($0.050), plus its next row at its most ($0.050).')
  assert.equal(leastLine(view({ cut_off_usd: 0.012, least_usd: 0.112001 })), 'It needs at least $0.112001 to go '
    + 'on: what it spent ($0.050), plus $0.012 for calls cut off before they answered (they may still be billed), '
    + 'plus its next row at its most ($0.050).')
  assert.equal(leastLine(view({ next_row_usd: null, least_usd: 0.100001 })),
    'It needs at least $0.100001 to go on: more than its old limit and what it spent ($0.050).')
  assert.equal(tooLowLine(view()), 'Enter at least $0.100001.')
})

check('why it paused: the message the run left, else its limit and what it spent', () => {
  assert.equal(pauseLine(view({ message: 'The run reached its $0.10 spend limit ($0.05 spent).' })),
    'The run reached its $0.10 spend limit ($0.05 spent).')
  assert.equal(pauseLine(view()), 'The run reached its $0.10 spend limit ($0.050 spent).')
})

check('what the amount filled in covers, and the runs still to ask', () => {
  assert.equal(suggestLine(view()), 'The amount filled in is enough for the 4 rows left, each at that most.')
  assert.equal(suggestLine(view({ next_row_usd: null })), null)
  assert.equal(suggestLine(view({ rows_left: 0 })), null)
  assert.equal(queuedLine(0), null)
  assert.equal(queuedLine(1), 'Then 1 more run that stopped at its spend limit, one at a time.')
  assert.equal(queuedLine(2), 'Then 2 more runs that stopped at their spend limit, one at a time.')
})

if (failures) { console.log(`${failures} failed`); process.exit(1) }

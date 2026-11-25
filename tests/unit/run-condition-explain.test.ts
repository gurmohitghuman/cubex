// Why a row doesn't pass an "Only run if" rule (lib/run-condition-explain.ts): each part that failed, in plain words,
// with what the cell holds; exactly the rows rulePasses refuses.
import assert from 'node:assert/strict'
import parseMod from '../../server/src/lib/run-condition-parse'
import condMod from '../../server/src/lib/run-condition'
import explainMod from '../../server/src/lib/run-condition-explain'
const { parseRule } = parseMod as typeof import('../../server/src/lib/run-condition-parse')
const { rulePasses } = condMod as typeof import('../../server/src/lib/run-condition')
const { ruleMisses } = explainMod as typeof import('../../server/src/lib/run-condition-explain')

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const why = (rule: string, data: Record<string, string>) => {
  const tree = parseRule(rule)
  const out = ruleMisses(tree, data)
  assert.equal(out.length === 0, rulePasses(tree, data), `explains exactly the rows the rule refuses: ${rule}`)
  return out
}

check('one comparison: what the cell holds and what the rule needs', () => {
  assert.deepEqual(why('{{Country}} is "US"', { Country: 'DE' }), ['Country is "DE"; the rule needs it to be "US".'])
  assert.deepEqual(why('{{Country}} is "US"', { Country: 'us' }), [])
  assert.deepEqual(why('{{Email}} is not empty', { Email: '  ' }),
    ['Email is empty; the rule needs it to have a value.'])
  assert.deepEqual(why('{{Name}} contains "inc"', { Name: 'Acme' }),
    ['Name is "Acme"; the rule needs it to contain "inc".'])
})

check('a run\'s own words read as empty, as the rule reads them', () => {
  assert.deepEqual(why('{{Email}} is not empty', { Email: '⏳ Processing...' }),
    ['Email is empty; the rule needs it to have a value.'])
  assert.deepEqual(why('{{Email}} is not empty', {}), ['Email is empty; the rule needs it to have a value.'])
})

check('numbers and dates: a cell that isn\'t one says so', () => {
  assert.deepEqual(why('{{Revenue}} > 50', { Revenue: 'n/a' }),
    ['Revenue is "n/a", not a number; the rule needs it to be a number above 50.'])
  assert.deepEqual(why('{{Revenue}} >= 50', { Revenue: '12' }),
    ['Revenue is "12"; the rule needs it to be a number of 50 or more.'])
  assert.deepEqual(why('{{Date}} is before "2024-01-31"', { Date: '2024-02-10' }),
    ['Date is "2024-02-10"; the rule needs it to be a date before 2024-01-31.'])
  assert.deepEqual(why('{{Date}} is before "2024-01-31"', { Date: 'soon' }),
    ['Date is "soon", not a date; the rule needs it to be a date before 2024-01-31.'])
})

check('AND: each part that failed; OR: one reason naming every choice', () => {
  assert.deepEqual(why('{{Country}} is "US" AND {{Size}} > 10', { Country: 'DE', Size: '3' }), [
    'Country is "DE"; the rule needs it to be "US".', 'Size is "3"; the rule needs it to be a number above 10.',
  ])
  assert.deepEqual(why('{{Country}} is "US" AND {{Size}} > 10', { Country: 'US', Size: '3' }),
    ['Size is "3"; the rule needs it to be a number above 10.'])
  assert.deepEqual(why('{{Country}} is "US" OR {{Country}} is "CA"', { Country: 'DE' }), [
    'None of these held: Country is "DE" (it needs to be "US"), or Country is "DE" (it needs to be "CA").',
  ])
  assert.deepEqual(why('{{Country}} is "US" OR {{Country}} is "CA"', { Country: 'CA' }), [])
})

check('NOT: the comparison under it, the other way round', () => {
  assert.deepEqual(why('NOT {{Country}} is "DE"', { Country: 'DE' }),
    ['Country is "DE"; the rule needs it not to be "DE".'])
  assert.deepEqual(why('NOT ({{A}} is "x" OR {{B}} is "y")', { A: 'x', B: 'z' }),
    ['A is "x"; the rule needs it not to be "x".'])
  assert.deepEqual(why('NOT ({{A}} is "x" AND {{B}} is "y")', { A: 'x', B: 'y' }), [
    'None of these held: A is "x" (it needs not to be "x"), or B is "y" (it needs not to be "y").',
  ])
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('all run-condition-explain checks passed')

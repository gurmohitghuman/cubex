// "Only run if" rules (lib/run-condition.ts): the language, the column checks,
// how rows pass, and the rewrites a rename and an old condition list need.
import assert from 'node:assert/strict'
import mod from '../../server/src/lib/run-condition'
const { checkRule, rulePasses, renameRuleColumn, ruleFromConditions, ruleColumns, RuleError } =
  mod as typeof import('../../server/src/lib/run-condition')

const cols = ['Industry', 'Employees', 'Email status', 'Company Fit (Output)', 'Notes']
const passes = (rule: string, data: Record<string, string>) => rulePasses(checkRule(rule, cols).tree, data)
const refused = (rule: string, msg: RegExp) =>
  assert.throws(() => checkRule(rule, cols), (e: unknown) => e instanceof RuleError && msg.test(e.message), rule)

// Written back in one spelling, with brackets only where they matter.
assert.equal(checkRule('({{industry}} = "SaaS" || {{Industry}} is \'Fintech\') && {{Employees}} >= 50', cols).rule,
  '({{Industry}} is "SaaS" OR {{Industry}} is "Fintech") AND {{Employees}} >= 50')
assert.equal(checkRule('not {{Notes}} is empty and !({{Email status}} != "valid")', cols).rule,
  'NOT ({{Notes}} is empty) AND NOT ({{Email status}} is not "valid")')
assert.equal(checkRule('{{company_fit_output}} does not contain "no"', cols).rule,
  '{{Company Fit (Output)}} does not contain "no"')
assert.deepEqual(checkRule('{{Industry}} is "a" OR {{Employees}} > 1 OR {{Industry}} is empty', cols).columns,
  ['Industry', 'Employees'])
// Formatting is stable: a written-back rule reads the same again.
const once = checkRule('{{Notes}} contains "say \\"hi\\"" AND ({{Employees}} < 5 OR {{Employees}} > 9)', cols).rule
assert.equal(checkRule(once, cols).rule, once)

// AND before OR, NOT before AND.
assert.equal(passes('{{Industry}} is "x" OR {{Industry}} is "saas" AND {{Employees}} > 100',
  { Industry: 'SaaS', Employees: '10' }), false)
assert.equal(passes('{{Industry}} is "saas" OR {{Industry}} is "x" AND {{Employees}} > 100',
  { Industry: 'SaaS', Employees: '10' }), true)

// Text: case and outer spaces ignored. Numbers: commas fine, text never > anything.
assert.equal(passes('{{Industry}} is "saas"', { Industry: '  SaaS ' }), true)
assert.equal(passes('{{Employees}} > 1000', { Employees: '1,200' }), true)
assert.equal(passes('{{Employees}} > 10', { Employees: '51-200' }), false)
assert.equal(passes('{{Employees}} <= 10', { Employees: '' }), false)
assert.equal(passes('{{Employees}} is 50', { Employees: '50.0' }), true)
assert.equal(passes('{{Employees}} is "50"', { Employees: '50.0' }), false)
// A missing cell is empty; a run's own words read as empty too.
assert.equal(passes('{{Notes}} is empty', {}), true)
const markers = ['⏳ Processing...', '❌ Timed out', '⏭️ Not found', '⏭️ Condition not met', '➕ 3 rows']
for (const marker of markers) {
  assert.equal(passes('{{Company Fit (Output)}} is not empty', { 'Company Fit (Output)': marker }), false, marker)
}
assert.equal(passes('{{Industry}} does not contain "bank"', { Industry: 'Banking' }), false)

// Refused, with a message a person can act on.
refused('{{Industri}} is "x"', /no column named "Industri"\. Did you mean "Industry"\?/)
refused('{{Industry}} is SaaS', /Expected a value in quotes or a number, found "SaaS"/)
refused('{{Industry}} is "x" AND', /Expected a column like \{\{Industry\}\}, found the end/)
refused('({{Industry}} is "x"', /closing bracket/)
refused('{{Industry is "x"', /closing \}\}/)
refused('{{Industry}} is "x', /closing "/)
refused('{{Industry}} ~ "x"', /"~" isn't part of a rule/)
refused('', /empty/)
refused('x'.repeat(2001), /at most 2000 characters/)
refused('('.repeat(30) + '{{Industry}} is "x"' + ')'.repeat(30), /nested too deeply/)

// Rename rewrites only that column; a rule that doesn't parse stays as it is.
assert.equal(renameRuleColumn('{{Industry}} is "a" AND {{Notes}} is empty', 'Industry', 'Sector'),
  '{{Sector}} is "a" AND {{Notes}} is empty')
assert.equal(renameRuleColumn('{{Notes}} is empty', 'Industry', 'Sector'), '{{Notes}} is empty')
assert.equal(renameRuleColumn('{{Industry}} is', 'Industry', 'Sector'), '{{Industry}} is')
assert.deepEqual(ruleColumns('{{Gone}} > 1 OR {{Notes}} is empty'), ['Gone', 'Notes'])
assert.deepEqual(ruleColumns('broken'), [])

// Old enrichment condition lists become the same rule.
assert.equal(ruleFromConditions([]), null)
assert.equal(ruleFromConditions([
  { column: 'Email status', op: 'eq', value: 'valid' }, { column: 'Employees', op: 'gt', value: '50' },
  { column: 'Notes', op: 'not_empty', value: '' },
]), '{{Email status}} is "valid" AND {{Employees}} > 50 AND {{Notes}} is not empty')

// Review fixes: values the parser can't read bare stay quoted; a long stored
// rule still reads; a name ending in "}" can be named; a rename to a name a
// rule can't hold leaves the rule naming the old (now gone) column.
assert.equal(ruleFromConditions([{ column: 'Employees', op: 'gt', value: '1,000' }]), '{{Employees}} > "1,000"')
assert.equal(passes('{{Employees}} > "1,000"', { Employees: '1200' }), true)
const long = `${`{{Notes}} is "${'x'.repeat(60)}" OR `.repeat(40)}{{Notes}} is empty`
assert.ok(long.length > 2000)
assert.deepEqual(ruleColumns(long), ['Notes'])
assert.deepEqual(checkRule('{{Size}}} > 1', ['Size}']).columns, ['Size}'])
assert.equal(renameRuleColumn('{{Notes}} is empty', 'Notes', 'A}}B'), '{{Notes}} is empty')
refused('{{Notes}} is "' + 'x'.repeat(2000) + '"', /at most 2000 characters/)

// Which cells "⏭️ Condition not met" may replace: never a result.
import markersMod from '../../server/src/lib/run-markers'
const { takesConditionMark } = markersMod as typeof import('../../server/src/lib/run-markers')
for (const v of ['', '  ', '⏳ Processing...', '❌ Error: x', '⏭️ Condition not met']) {
  assert.equal(takesConditionMark(v), true, v)
}
for (const v of ['⏭️ Not found', '⏭️ Skipped', '✅ Found', '➕ 3 rows', 'yes']) {
  assert.equal(takesConditionMark(v), false, v)
}

console.log('run-condition: all passed')

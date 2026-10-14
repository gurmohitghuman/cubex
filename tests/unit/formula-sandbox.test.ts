// Unit test for formula columns' language (lib/formula/): references compiled
// against the sheet's columns, a row's cells in and out, and the sandbox (the
// formula worker's QuickJS): results, errors, Lodash, no host access,
// time/memory/stack limits, a long built-in call stopped by wall clock (the
// worker is stopped and started again), and the runner out of the formula's reach.
// server/src is type:commonjs → default-import + destructure under tsx.
import refsMod from '../../server/src/lib/formula/refs'
import cellsMod from '../../server/src/lib/formula/cells'
import sandboxMod from '../../server/src/lib/formula/sandbox'
const { compileFormula, renameFormulaRefs, formulaRefProblem, FormulaError } =
  refsMod as typeof import('../../server/src/lib/formula/refs')
const { formulaRow, formulaCell, jsonDepthWithin } = cellsMod as typeof import('../../server/src/lib/formula/cells')
const { FormulaSandbox } = sandboxMod as typeof import('../../server/src/lib/formula/sandbox')

let failures = 0
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, got === undefined ? '' : JSON.stringify(got)) }
}
function throwsFormula(label: string, f: () => unknown, includes: string) {
  try { f(); check(label, false, 'no error') } catch (e) {
    const msg = (e as Error).message
    check(`${label}: ${msg}`, e instanceof FormulaError && msg.includes(includes), msg)
  }
}

const COLS = ['Response', 'Name', 'First Name', 'Score', 'Tags', 'A', 'B']

// --- references ---------------------------------------------------------------
{
  const c = compileFormula('{{response}}?.emails?.find(e => e.type == "work")?.value', COLS)
  check('case-insensitive ref written back exactly',
    c.formula === '{{Response}}?.emails?.find(e => e.type == "work")?.value', c.formula)
  check('one input', JSON.stringify(c.inputs) === '["Response"]', c.inputs)
  check('compiled to __v[0]', c.source.startsWith('__v[0]?.emails'), c.source)
  check('no lodash', !c.usesLodash)
}
check('normalized name resolves', compileFormula('{{first_name}}', COLS).inputs[0] === 'First Name')
throwsFormula('unknown column refused with a suggestion', () => compileFormula('{{Nme}}', COLS), 'Did you mean "Name"')
throwsFormula('empty reference', () => compileFormula('{{ }} + 1', COLS), 'empty')
throwsFormula('unclosed reference', () => compileFormula('{{Name + 1', COLS), 'closing }}')
throwsFormula('unclosed string', () => compileFormula('"abc + {{Name}}', COLS), 'closing quote')
throwsFormula('empty formula', () => compileFormula('   ', COLS), 'Write a formula')
check('quoted string with a ref becomes a template',
  compileFormula('"Hello {{Name}}!"', COLS).source === '`Hello ${__v[0]}!`')
check('template text ref', compileFormula('`Hi {{Name}}`', COLS).source === '`Hi ${__v[0]}`')
check('template expression ref', compileFormula('`Hi ${{{Name}}}`', COLS).source === '`Hi ${__v[0]}`')
check('object literal around a ref', compileFormula('({ n: {{Name}}})', COLS).source === '({ n: __v[0]})')
{
  const c = compileFormula('"{{nope}} {{ x }}" + {{Name}}', COLS)
  check('unknown ref inside a string is text, kept so no later column turns it into one',
    c.formula === '"{\\{nope}} {\\{ x }}" + {{Name}}' && c.source === '"{\\{nope}} {\\{ x }}" + __v[0]'
    && JSON.stringify(c.inputs) === '["Name"]', c)
  check('an escaped one stays text when compiled again',
    compileFormula(c.formula, [...COLS, 'nope']).inputs.length === 1)
}
{
  const c = compileFormula('{{A}} / 2 / {{B}} // {{Score}}', COLS)
  check('division between refs, comment ignored', c.source === '__v[0] / 2 / __v[1] // {{Score}}' &&
    JSON.stringify(c.inputs) === '["A","B"]', c)
}
check('regex literal kept as written',
  compileFormula('{{Name}}.replace(/[{}]+/g, "")', COLS).source === '__v[0].replace(/[{}]+/g, "")')
check('regex after =>', compileFormula('[{{Name}}].filter(x => /a/.test(x)).length', COLS).inputs.length === 1)
check('lodash detected', compileFormula('_.uniq({{Tags}})', COLS).usesLodash)
check('first_name is not lodash', !compileFormula('{{Name}}.first_name', COLS).usesLodash)
check('braces at a name end refused', formulaRefProblem('Size}') !== null && formulaRefProblem('{x') !== null &&
  formulaRefProblem('a}}b') !== null && formulaRefProblem('Size') === null)
check('rename rewrites code and text refs', renameFormulaRefs('{{Name}} + "{{Name}}" + {{A}}', 'Name', 'Full Name') ===
  '{{Full Name}} + "{{Full Name}}" + {{A}}')

// --- cells in and out ---------------------------------------------------------
{
  const deep = '['.repeat(150) + ']'.repeat(150)
  const row = formulaRow(['⏳ Processing...', '{"a":1}', ' [1]', deep, 42, null, '❌ Error', '[not json'])
  check('markers read as empty, numbers as text', JSON.stringify(row.v.slice(0, 3)) === '["","{\\"a\\":1}"," [1]"]' &&
    row.v[4] === '42' && row.v[5] === '' && row.v[6] === '', row.v)
  check('JSON cells marked, too-deep one not', JSON.stringify(row.j) === '[1,2,7]', row.j)
  check('depth scan skips strings', jsonDepthWithin('{"a":"[[[[[[["}', 2) && !jsonDepthWithin('[[[1]]]', 2))
  const bidi = String.fromCodePoint(0x202E)
  check('value cleaned', formulaCell({ ok: true, value: `ok${bidi}\u0007!` }) === 'ok!')
  const err = formulaCell({ ok: false, error: 'TypeError: ' + 'x'.repeat(500), runaway: false })
  check('error cell starts with ❌ and is short', err.startsWith('❌ TypeError') && err.length <= 120, err.length)
}

// --- the sandbox --------------------------------------------------------------
async function runOne(formula: string, cells: unknown[], cols = COLS) {
  const sb = await FormulaSandbox.open(compileFormula(formula, cols))
  try { return sb.runRows([formulaRow(cells)], 100).outcomes[0] } finally { sb.dispose() }
}
const RESPONSE = JSON.stringify({
  emails: [{ type: 'personal', value: 'a@gmail.com' }, { type: 'work', value: 'jane@acme.com' }],
})
const value = (o: { ok: boolean } & Record<string, unknown>) => (o.ok ? o.value : `ERR ${o.error}`)

const work = '{{Response}}?.emails?.find(e => e.type == "work")?.value'
check('work email picked by condition', value(await runOne(work, [RESPONSE])) === 'jane@acme.com')
check('missing data reads empty', value(await runOne(work, ['{"emails":[]}'])) === '')
check('marker input reads empty', value(await runOne(work, ['⏳ Processing...'])) === '')
{
  const o = await runOne('{{Response}}.emails.find(e => e.type == "nope").value', [RESPONSE])
  check('TypeError is a row error, not a runaway', !o.ok && !o.runaway && /TypeError/.test(o.error), o)
}
const cases: [string, unknown[], string][] = [
  ['Number({{Score}}) * 2', ['21'], '42'],
  ['Number({{Score}}) * 2', ['abc'], ''],
  ['{{Score}} > 5', ['9'], 'true'],
  ['({ n: {{Name}} })', ['Jane'], '{"n":"Jane"}'],
  ['[{{Name}}, 1]', ['Jane'], '["Jane",1]'],
  ['new Date(Date.UTC(2026, 0, 2))', [], '2026-01-02T00:00:00.000Z'],
  ['null', [], ''],
  ['"Hi {{Name}}"', ['Jane'], 'Hi Jane'],
  ['`${{{Name}}.toUpperCase()}!`', ['Jane'], 'JANE!'],
  ['_.uniq({{Tags}}.split(",")).join(",")', ['a,b,a'], 'a,b'],
  ['typeof require + typeof process + typeof fetch + typeof setTimeout + typeof console', [], 'undefined'.repeat(5)],
]
for (const [f, cells, want] of cases) {
  const got = value(await runOne(f, cells))
  check(`${f} → ${JSON.stringify(want)}`, got === want, got)
}
try {
  await FormulaSandbox.open(compileFormula('{{Name}} +* 2', COLS))
  check('syntax error refused at open', false)
} catch (e) {
  const msg = (e as Error).message
  check(`syntax error refused at open: ${msg}`, e instanceof FormulaError && /SyntaxError/.test(msg))
}

{
  const sb = await FormulaSandbox.open(compileFormula([
    '{{Name}} == "loop" ? (() => { while (true) {} })()',
    ': {{Name}} == "mem" ? "x".repeat(2e8).length',
    ': {{Name}} == "deep" ? (function f(n) { return f(n + 1) })(0)',
    ': {{Name}} == "json" ? (JSON = null, "x")',
    ': {{Name}} == "runner" ? (parse = () => ({ v: ["p"], j: [] }), str = null, f = null, "set") : {{Name}}',
  ].join(' '), ['Name']))
  const one = (name: string) => sb.runRows([formulaRow([name])], 100).outcomes[0]
  const t0 = Date.now()
  const loop = one('loop')
  check('endless loop stopped as a runaway',
    !loop.ok && loop.runaway && /too long/.test(loop.error) && Date.now() - t0 < 1000, loop)
  check('next row runs after a timeout', value(one('ok1')) === 'ok1')
  const mem = one('mem')
  check('memory bomb stopped as a runaway', !mem.ok && mem.runaway && /memory/.test(mem.error), mem)
  check('next row runs after out of memory', value(one('ok2')) === 'ok2')
  const deep = one('deep')
  check('recursion stopped inside the sandbox', !deep.ok && /stack overflow/.test(deep.error), deep)
  one('json')
  check('reassigning JSON changes only that row', value(one('ok3')) === 'ok3')
  check('the formula can\'t reach the runner', value(one('runner')) === 'set' && value(one('ok4')) === 'ok4')
  // Several rows in one request: as many as fit the budget, at least one.
  const many = Array.from({ length: 2000 }, (_, i) => formulaRow([`r${i}`]))
  const all = sb.runRows(many, 1000)
  check('a batch works out every row in its budget',
    all.outcomes.length === 2000 && value(all.outcomes[1999]) === 'r1999')
  const some = sb.runRows([formulaRow(['loop']), formulaRow(['a']), formulaRow(['b'])], 1)
  check('a batch past its budget stops early, after at least one row', some.outcomes.length === 1, some)
  sb.dispose()
}

// A long built-in call isn't stopped by QuickJS's own deadline: the worker is
// stopped by wall clock, the formula opens again in a new one, and the row it
// hung on is answered "took too long" without running it again.
{
  const slow = '{{Name}} == "slow" ? ("a".repeat(2e7) + "b").indexOf("a".repeat(1e4) + "c") : {{Name}}'
  const sb = await FormulaSandbox.open(compileFormula(slow, ['Name']))
  const other = await FormulaSandbox.open(compileFormula('{{Name}} + "!"', ['Name']))
  const rows = [formulaRow(['a']), formulaRow(['slow']), formulaRow(['b'])]
  const t0 = Date.now()
  const first = sb.runRows(rows, 100)
  check(`a long built-in call is stopped by wall clock (${Date.now() - t0} ms)`,
    first.closed && first.outcomes.length === 0 && Date.now() - t0 < 1000, first)
  check('every formula in the stopped worker is closed', other.runRows([formulaRow(['x'])], 100).closed)
  await sb.ensure()
  await other.ensure()
  const again = sb.runRows(rows, 100)
  check('after reopening, the rows before the one that hung run again',
    again.outcomes.length === 1 && value(again.outcomes[0]) === 'a', again)
  const hung = sb.runRows(rows.slice(1), 100)
  check('the row that hung is answered without running it', hung.outcomes.length === 1
    && !hung.outcomes[0].ok && hung.outcomes[0].runaway && /too long/.test(hung.outcomes[0].error), hung)
  check('then the rows after it run', value(sb.runRows(rows.slice(2), 100).outcomes[0]) === 'b')
  check('the other formula runs again too', value(other.runRows([formulaRow(['x'])], 100).outcomes[0]) === 'x!')
  sb.dispose()
  other.dispose()
}

{
  const sb = await FormulaSandbox.open(compileFormula(work, COLS))
  const t0 = performance.now()
  for (let i = 0; i < 20; i++) sb.runRows(Array.from({ length: 1000 }, () => formulaRow([RESPONSE])), 1000)
  const ms = performance.now() - t0
  sb.dispose()
  check(`20,000 rows in ${ms.toFixed(0)} ms`, ms < 3000)
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall formula sandbox checks passed')

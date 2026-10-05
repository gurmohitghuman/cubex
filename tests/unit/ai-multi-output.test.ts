// Unit test for lib/ai-multi-output.ts — the pure parse/coerce core of
// structured multi-column AI output. Pure functions, no DB.
// server/src is type:commonjs → default-import + destructure under tsx.
import aiMulti from '../../server/src/lib/ai-multi-output'
const { buildMultiOutputInstruction, coerceOutputValue, parseMultiOutput } =
  aiMulti as typeof import('../../server/src/lib/ai-multi-output')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const specs = [
  { columnName: 'Fit Score', type: 'number' as const, description: 'How well it fits' },
  { columnName: 'Fit Reason', type: 'string' as const, description: 'Why' },
  { columnName: 'Is B2B', type: 'boolean' as const, description: 'B2B?' },
]

// Instruction mentions every column name.
const instr = buildMultiOutputInstruction(specs)
check('instruction lists all keys', ['Fit Score', 'Fit Reason', 'Is B2B'].every(k => instr.includes(k)))

// coerceOutputValue — numbers
check('number from number', coerceOutputValue(8, 'number') === '8')
check('number from numeric string', coerceOutputValue('8.5', 'number') === '8.5')
check('number from junk is blank', coerceOutputValue('N/A', 'number') === '')
check('number from null is blank', coerceOutputValue(null, 'number') === '')
// booleans
check('bool from bool', coerceOutputValue(true, 'boolean') === 'true')
check('bool from yes', coerceOutputValue('yes', 'boolean') === 'true')
check('bool from 0', coerceOutputValue('0', 'boolean') === 'false')
check('bool from junk blank', coerceOutputValue('maybe', 'boolean') === '')
// strings
check('string passthrough', coerceOutputValue('hello', 'string') === 'hello')
check('string from number', coerceOutputValue(3, 'string') === '3')
check('string from object serializes', coerceOutputValue({ a: 1 }, 'string') === '{"a":1}')

// parseMultiOutput — happy path
const good = parseMultiOutput('{"Fit Score": 8, "Fit Reason": "B2B SaaS", "Is B2B": true}', specs)
check('good parse ok', 'ok' in good)
if ('ok' in good) {
  check('good coerces number', good.ok['Fit Score'] === '8')
  check('good coerces string', good.ok['Fit Reason'] === 'B2B SaaS')
  check('good coerces bool', good.ok['Is B2B'] === 'true')
}

// fenced JSON is stripped
const fenced = parseMultiOutput('```json\n{"Fit Score": 5, "Fit Reason": "x", "Is B2B": false}\n```', specs)
check('fenced parse ok', 'ok' in fenced && fenced.ok['Fit Score'] === '5')

// missing key → blank, NOT an error
const missing = parseMultiOutput('{"Fit Score": 9}', specs)
check('missing key blanks, not error', 'ok' in missing && missing.ok['Fit Reason'] === '' && missing.ok['Is B2B'] === '')

// whole-object failures → error (→ status column ❌)
check('prose → error', 'error' in parseMultiOutput('I think it scores 8', specs))
check('array → error', 'error' in parseMultiOutput('[1,2,3]', specs))
check('primitive → error', 'error' in parseMultiOutput('42', specs))
check('empty → error', 'error' in parseMultiOutput('', specs))

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ai-multi-output checks passed')

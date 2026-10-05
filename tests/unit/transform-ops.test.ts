// Unit test for lib/transform-ops.ts — pure cell transforms + the ReDoS guard.
// server/src is type:commonjs → default-import + destructure under tsx.
import transformOps from '../../server/src/lib/transform-ops'
const { validateRegexPattern, applyCellOp, applyTemplate } =
  transformOps as typeof import('../../server/src/lib/transform-ops')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// ReDoS guard: safe patterns pass, catastrophic-backtracking shapes are rejected.
check('simple pattern ok', validateRegexPattern('^(\\d+)') === null)
check('email-ish pattern ok', validateRegexPattern('(\\w+@\\w+\\.\\w+)') === null)
check('nested quantifier (a+)+ rejected', validateRegexPattern('(a+)+$') !== null)
check('nested quantifier (a*)* rejected', validateRegexPattern('(a*)*') !== null)

// --- NESTED-group bypasses (the 2026-07-25 audit) ---------------------------
// The original guard was a regex: /\([^)]*[*+|][^)]*\)\s*[*+]/. `[^)]*` cannot
// see past an inner ')', so it caught the FLAT shape (a+)+ and missed every
// nested one. Measured against that guard: ((a+))+b was ALLOWED and took 8.8s
// on a 30-char input, doubling per added character (~35s at 32, minutes at 40).
// The input cap (10k chars) does not help — the blowup is exponential in LENGTH,
// so a 32-character cell is already fatal. And transform runs the match INSIDE
// a BEGIN IMMEDIATE txn, so it holds the SQLite writer lock while it hangs:
// one write-scoped token stalls every tenant. Hence a structural parse, not a
// pattern match. These are the exact shapes that got through.
const evil = [
  '((a+))+b',            // one plain wrapper hides the inner quantifier
  '(((a+)))+b',          // ...at any depth
  '((\\w)+\\s?)*$',
  '(([a-z]+))+$',
  '^((a)+)+$',
  '(([a-z])+.)+[A-Z]',   // classic OWASP shape
  '((a{1,3})+)+b',       // counted quantifier inside
  '(\\d+|\\w+)*$',       // quantified alternation
]
for (const p of evil) check(`nested ReDoS rejected: ${p}`, validateRegexPattern(p) !== null)

// Over-rejection matters too: the guard is deliberately conservative, but these
// ordinary extraction patterns must keep working or transform_column is useless.
const safe = [
  '^(\\d+)', '(\\w+@\\w+\\.\\w+)', '^(.*?),', '([A-Z]{2,3})-(\\d+)',
  '^\\s*(\\S+)', '(\\d{4})-(\\d{2})-(\\d{2})', 'https?://([^/]+)', '([0-9.]+)%', '(foo|bar)',
]
for (const p of safe) check(`safe pattern still allowed: ${p}`, validateRegexPattern(p) === null)

// Behavioral backstop: whatever the guard's rules, nothing it ACCEPTS may blow
// up. If a future edit loosens the parse, this catches it by the clock.
for (const p of safe) {
  const t0 = Date.now()
  try { new RegExp(p).exec('a'.repeat(40) + '!' + 'b'.repeat(40)) } catch { /* n/a */ }
  check(`accepted pattern runs fast: ${p}`, Date.now() - t0 < 200)
}
check('quantified alternation (a|a)* rejected', validateRegexPattern('(a|a)*') !== null)
check('empty pattern rejected', validateRegexPattern('') !== null)
check('too-long pattern rejected', validateRegexPattern('a'.repeat(300)) !== null)
check('invalid regex rejected', validateRegexPattern('(unclosed') !== null)

// regex_extract — capture group 1, then whole match, then ''
check('regex_extract group 1', applyCellOp('regex_extract', '8 | B2B SaaS', { pattern: '^(\\d+)' }) === '8')
check('regex_extract no match → blank', applyCellOp('regex_extract', 'no digits', { pattern: '^(\\d+)' }) === '')

// split — by delimiter, keep index
check('split keeps index', applyCellOp('split', 'a,b,c', { pattern: ',', index: 1 }) === 'b')
check('split default index 0', applyCellOp('split', 'a,b,c', { pattern: ',' }) === 'a')
check('split out-of-range → blank', applyCellOp('split', 'a,b', { pattern: ',', index: 9 }) === '')

// case + trim
check('upper', applyCellOp('upper', 'aB', {}) === 'AB')
check('lower', applyCellOp('lower', 'aB', {}) === 'ab')
check('trim', applyCellOp('trim', '  x  ', {}) === 'x')

// to_number — numeric passes through, junk blanks
check('to_number numeric', applyCellOp('to_number', ' 8.5 ', {}) === '8.5')
check('to_number junk → blank', applyCellOp('to_number', 'N/A', {}) === '')

// template — substitutes from row, unknown column → blank
check('template substitutes', applyTemplate('{{First}} {{Last}}', { First: 'Ada', Last: 'L' }) === 'Ada L')
check('template unknown col → blank', applyTemplate('[{{nope}}]', { First: 'x' }) === '[]')
check('template trims token spaces', applyTemplate('{{ First }}', { First: 'x' }) === 'x')

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall transform-ops checks passed')

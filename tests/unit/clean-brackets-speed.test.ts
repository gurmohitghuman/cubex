// The company name cleaner on values full of brackets that never close
// (lib/clean/company.ts): it finds them in one pass and cuts the leading ones
// at once, so a value of up to MAX_CLEAN_FIELD_CHARS characters costs well
// under 5 ms, in a clean column and in a company duplicate key (lib/dedupe/key.ts)
// alike. Each value is timed as the best of a few rounds, so a busy machine
// doesn't decide it. server/src is type:commonjs → default-import + destructure.
import assert from 'node:assert/strict'
import companyMod from '../../server/src/lib/clean/company'
import keyMod from '../../server/src/lib/dedupe/key'
const { cleanCompanyName } = companyMod as typeof import('../../server/src/lib/clean/company')
const { keyPart } = keyMod as typeof import('../../server/src/lib/dedupe/key')

const LIMIT_MS = 5
const ROUNDS = 3
const CALLS = 10

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// Milliseconds a call, the best round of ROUNDS (CALLS calls each) after one warm-up call.
function msPerCall(f: (v: string) => string, v: string): number {
  f(v)
  let best = Infinity
  for (let r = 0; r < ROUNDS; r++) {
    const t = performance.now()
    for (let i = 0; i < CALLS; i++) f(v)
    best = Math.min(best, (performance.now() - t) / CALLS)
  }
  return best
}

const cleaners: Array<[string, (v: string) => string]> = [
  ['company_name', v => cleanCompanyName(v)],
  ['company_name keep', v => cleanCompanyName(v, 'keep')],
  ['company duplicate key', v => keyPart({ column: 'C', match: 'company' }, v)],
]
for (const open of ['(', '[', '{']) {
  const values = [`${open} `.repeat(499) + 'x', open.repeat(667) + 'x'.repeat(333)]
  for (const v of values) {
    assert.ok(v.length <= 1000)
    const label = `${JSON.stringify(v.slice(0, 6))}... (${v.length} characters)`
    for (const [name, f] of cleaners) {
      const ms = msPerCall(f, v)
      check(`${name} on ${label}: ${ms.toFixed(2)} ms a call, under ${LIMIT_MS}`, ms < LIMIT_MS)
      check(`${name} on ${label}: no bracket left`, !/[([{]/.test(f(v)))
    }
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall clean-brackets-speed checks passed')

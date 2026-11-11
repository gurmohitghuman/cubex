// Cleaning a cleaned value changes nothing, for every cleaner and every option
// (lib/clean/cleaners.ts): auto-run cleans a row again whenever its source
// changes. Values are made at random (a fixed seed, so a failure repeats) from
// names, titles, initials, suffixes, particles, legal endings, brackets,
// placeholders, emoji, full-width letters and characters that stay as typed.
// server/src is type:commonjs → default-import + destructure under tsx.
import cleanersMod from '../../server/src/lib/clean/cleaners'
const { cleanerFn } = cleanersMod as typeof import('../../server/src/lib/clean/cleaners')
type CleanerId = import('../../server/src/lib/clean/cleaners').CleanerId
type CleanOptions = import('../../server/src/lib/clean/cleaners').CleanOptions

const VALUES = 3000
const MAX_WORDS = 6
const SEED = 52

// mulberry32: a small seeded generator.
let state = SEED
function random(): number {
  state = (state + 0x6D2B79F5) | 0
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]

const WORDS = [
  'John', 'MARY', 'ann', "o'brien", 'McDONALD', 'macdonald', 'Smith', 'JONES', 'Kowalski', 'DeShawn', 'Michael',
  '王', '伟', '민', 'Nil', 'Blank', 'Null', 'Na', 'na', 'Mr.', 'Dr', 'Prof.', 'Sir', 'J.', 'J', 'R.', 'J.R.', 'AJ',
  'Jr.', 'III', 'PhD', 'MBA', 'van', 'VAN', 'der', 'de', 'la', 'St.', 'Le', 'bin', 'Inc.', 'LLC', 'Co.', 'Company',
  'Corp', 'GmbH', '& Co.', 'Ltd', 'The', 'THE', '(', ')', '[', ']', '{', '}', '(Bob)', '"Bill"', '(they/them)',
  'n/a', '#N/A', 'none', 'NULL', '-', '?', 'unknown', 'test', 'tbd', '👋', '🇺🇦', '👩🏽\u{200D}💻', '™', '℠', 'Ⓜ',
  'Ⓜ\u{FE0F}', '1\u{FE0F}\u{20E3}', 'Ｍｉｃｈａｅｌ', 'ＡＣＭＥ', 'ﬁnn', 'Mª', '№1', 'Ⅷ', 'E²', 'ทองคำ', '1st', '3M',
  'a subsidiary of', 'jo@acme.com', 'acme.com', '+1 212 555 0123', 'CafÃ©', 'O\u{B4}Brien', '',
]
const JOINS = [' ', ' ', ' ', ', ', '', '  ']

function value(): string {
  const n = 1 + Math.floor(random() * MAX_WORDS)
  let s = pick(WORDS)
  for (let i = 1; i < n; i++) s += pick(JOINS) + pick(WORDS)
  return s
}

const SETUPS: Array<[CleanerId, CleanOptions]> = [
  ['person_name', {}],
  ['first_name', {}], ['first_name', { nameInput: 'full_name' }], ['first_name', { nameInput: 'first_name' }],
  ['last_name', {}], ['last_name', { nameInput: 'full_name' }], ['last_name', { nameInput: 'last_name' }],
  ['company_name', {}], ['company_name', { theCompany: 'strip' }], ['company_name', { theCompany: 'keep' }],
  ['email', {}], ['domain', {}],
  ['phone', {}], ['phone', { phoneFormat: 'international', phoneCountry: 'GB' }], ['phone', { phoneFormat: 'e164' }],
  ['title_case', {}], ['lowercase', {}], ['trim', {}], ['fix_encoding', {}],
]

let failures = 0
let calls = 0
const shown = new Set<string>()
const values = Array.from({ length: VALUES }, value)
for (const [cleaner, options] of SETUPS) {
  const f = cleanerFn(cleaner, options)
  const name = `${cleaner}${Object.keys(options).length ? ` ${JSON.stringify(options)}` : ''}`
  let bad = 0
  for (const v of values) {
    const once = f(v)
    const twice = f(once)
    calls += 2
    if (twice === once) continue
    bad++
    if (shown.size < 20 && !shown.has(name + v)) {
      shown.add(name + v)
      console.log(`FAIL ${name} ${JSON.stringify(v)} → ${JSON.stringify(once)} → ${JSON.stringify(twice)}`)
    }
  }
  if (bad) failures++
  console.log(`${bad ? 'FAIL' : 'ok  '} ${name}: ${bad} of ${VALUES} values changed when cleaned again`)
}

if (failures) { console.error(`\n${failures} cleaner setup(s) failed`); process.exit(1) }
console.log(`\nall clean-idempotence-fuzz checks passed (${calls} calls)`)

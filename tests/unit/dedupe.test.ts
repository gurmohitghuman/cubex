// Removing duplicates, the pure part (lib/dedupe/): what a key cell matches
// on for each match type, how a row's key is built, and which rows go for
// each keep rule.
import assert from 'node:assert/strict'
import keyMod from '../../server/src/lib/dedupe/key'
import finderMod from '../../server/src/lib/dedupe/finder'
const { keyPart, rowKey } = keyMod as typeof import('../../server/src/lib/dedupe/key')
const { DuplicateFinder } = finderMod as typeof import('../../server/src/lib/dedupe/finder')
// The dialog's first guesses (client, no imports of its own; tsx has no "@/").
import { guessDedupeMatch, pickDedupeColumn } from '../../client/src/lib/dedupe'
type Match = import('../../server/src/lib/dedupe/key').DedupeMatch

let failures = 0
const ok = (label: string, fn: () => void) => {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const part = (match: Match, v: unknown, country?: string) => keyPart({ column: 'c', match, country }, v)
const same = (match: Match, a: string, b: string) => {
  const x = part(match, a), y = part(match, b)
  assert.ok(x !== '', `${match}: "${a}" reads as something`)
  assert.equal(x, y, `${match}: "${a}" matches "${b}"`)
}
const NBSP = String.fromCharCode(0xa0)
const E_ACUTE = String.fromCharCode(0xe9) // é, one character
const E_PLUS_ACCENT = 'e' + String.fromCharCode(0x301) // é, e and a combining accent

ok('text: case and extra spaces never matter, inner spaces collapse', () => {
  same('text', '  Acme  Corp ', 'ACME CORP')
  same('text', `Acme${NBSP}Corp`, 'acme corp')
  same('text', `Caf${E_ACUTE}`, `CAF${E_PLUS_ACCENT}`.toLowerCase())
  assert.notEqual(part('text', 'Jose'), part('text', `Jos${E_ACUTE}`), 'accents still count')
  assert.equal(part('text', 42), '42')
})

ok('empty cells and run statuses read as empty', () => {
  const statuses = ['⏳ Processing...', '❌ Error: 500', '⏭️ Not found', '➕ Adding 3 rows…']
  for (const v of ['', '   ', null, undefined, ...statuses]) assert.equal(part('text', v), '', `"${v}" is empty`)
})

ok('email, domain, company and person name match through the cleaners', () => {
  same('email', '<Jo@Acme.com>', 'jo@acme.com')
  assert.equal(part('email', 'n/a'), '', 'not an email: never matches')
  same('domain', 'https://www.acme.com/about', 'jo@acme.com')
  same('domain', 'ACME.com', 'http://acme.com')
  assert.equal(part('domain', 'unknown'), '')
  same('company', 'Acme, Inc.', 'ACME LLC')
  same('person_name', 'Smith, John', 'john smith')
})

ok('domain: a free email never matches; a shared site matches by page only', () => {
  assert.equal(part('domain', 'jo@gmail.com'), '')
  assert.equal(part('domain', 'gmail.com'), '')
  same('domain', 'https://www.facebook.com/JoesPizzaNYC/', 'm.facebook.com/joespizzanyc')
  assert.notEqual(part('domain', 'facebook.com/JoesPizzaNYC'), part('domain', 'facebook.com/acme'))
  assert.equal(part('domain', 'facebook.com'), '', 'the site itself says nothing about the business')
  assert.equal(part('domain', 'jo@linkedin.com'), '')
  assert.notEqual(part('domain', 'https://sites.google.com/view/acme'),
    part('domain', 'https://sites.google.com/view/beta'))
  assert.notEqual(part('domain', 'acme.substack.com'), part('domain', 'beta.substack.com'))
  same('domain', 'https://acme.myshopify.com/products/x', 'acme.myshopify.com')
})

ok('phone: an extension keeps people behind one switchboard apart', () => {
  same('phone', '(212) 555-0123 ext. 12', '+1 212 555 0123 x12')
  assert.notEqual(part('phone', '(212) 555-0123 ext. 12'), part('phone', '(212) 555-0123 x34'))
  assert.notEqual(part('phone', '(212) 555-0123 #7'), part('phone', '(212) 555-0123'))
  same('phone', '555-0100 x5', '5550100 ext 5')
})

ok('person name: Jr and Sr stay apart', () => {
  same('person_name', 'John Smith Jr.', 'Smith, John, Jr')
  assert.notEqual(part('person_name', 'John Smith Jr.'), part('person_name', 'John Smith Sr.'))
  assert.notEqual(part('person_name', 'John Smith III'), part('person_name', 'John Smith'))
  same('person_name', 'John Smith Junior', 'john smith jr')
})

ok('the dialog opens on the column that tells rows apart best', () => {
  const none = () => undefined
  assert.equal(pickDedupeColumn(['First Name', 'Last Name', 'Title', 'Company', 'Email', 'Phone'], none), 'Email')
  assert.equal(pickDedupeColumn(['First name', 'Last name', 'Company size', 'Mobile'], none), 'Mobile')
  assert.equal(pickDedupeColumn(['Business name', 'Address', 'Website'], none), 'Website')
  assert.equal(pickDedupeColumn(['Notes', 'Stage'], none), 'Notes')
  const cleaned = (c: string) => (c === 'Work (clean)' ? 'email' : undefined)
  assert.equal(pickDedupeColumn(['Notes', 'Work (clean)'], cleaned), 'Work (clean)')
  assert.equal(guessDedupeMatch('Company size'), 'text')
  assert.equal(guessDedupeMatch('Email status'), 'text')
  assert.equal(guessDedupeMatch('Phone type'), 'text')
  assert.equal(guessDedupeMatch('LinkedIn URL'), 'text')
  assert.equal(guessDedupeMatch('Company domain'), 'domain')
  assert.equal(guessDedupeMatch('Work email'), 'email')
})

ok('phone: any format; digits when the number cannot be placed; never a float', () => {
  same('phone', '(212) 555-0123', '+1 212 555 0123')
  same('phone', '212.555.0123', '2125550123')
  same('phone', '555-0100', '5550100')
  assert.equal(part('phone', '2.12555E+09'), '', 'a float that lost digits')
  assert.equal(part('phone', '12-34'), '', 'too few digits')
  assert.equal(part('phone', 'call me'), '')
  assert.notEqual(part('phone', '020 7946 0000', 'GB'), part('phone', '020 7946 0000', 'US'))
})

ok('rowKey: null when any part is empty, parts never run together, long keys hashed', () => {
  assert.equal(rowKey(['']), null)
  assert.equal(rowKey(['', '']), null)
  assert.equal(rowKey(['a', '']), null, 'a row missing one key value is never a duplicate')
  assert.equal(rowKey(['', 'a']), null)
  assert.notEqual(rowKey(['a', 'b']), rowKey(['a b']))
  assert.notEqual(rowKey(['a","b']), rowKey(['a', 'b']))
  const long = 'x'.repeat(500)
  assert.ok(rowKey([long])!.startsWith('#'))
  assert.equal(rowKey([long]), rowKey([long]))
  assert.notEqual(rowKey([long]), rowKey([long + 'y']))
})

// Rows 1…n with keys (null: empty) and filled counts.
const find = (keep: 'first' | 'last' | 'most_complete', keys: Array<string | null>, filled: number[] = []) => {
  const f = new DuplicateFinder(keep)
  keys.forEach((k, i) => f.add(100 + i, i + 1, k, filled[i] ?? 0))
  return f.result()
}
const removedRows = (r: ReturnType<typeof find>) => Array.from(r.remove, id => id - 99)

ok('keep first: the highest row of each group stays', () => {
  const r = find('first', ['a', 'b', 'a', null, 'a', 'b', null])
  assert.deepEqual(removedRows(r), [3, 5, 6])
  assert.equal(r.groups, 2)
  assert.equal(r.emptyKeyRows, 2, 'empty keys are never duplicates of each other')
  assert.deepEqual(r.samples[0], {
    kept: { rowid: 100, position: 1 }, removed: [{ rowid: 102, position: 3 }, { rowid: 104, position: 5 }], size: 3,
  })
  assert.equal(r.largest!.size, 3)
})

ok('keep last: the lowest row stays', () => {
  const r = find('last', ['a', 'b', 'a', 'a'])
  assert.deepEqual(removedRows(r), [1, 3])
  assert.equal(r.samples[0].kept.position, 4)
  assert.deepEqual(r.samples[0].removed.map(x => x.position), [1, 3])
})

ok('keep most complete: the row filling most cells stays, the highest of a tie', () => {
  const r = find('most_complete', ['a', 'a', 'a', 'a', 'b', 'b'], [2, 5, 5, 1, 3, 3])
  assert.deepEqual(removedRows(r), [1, 3, 4, 6])
  assert.equal(r.samples[0].kept.position, 2)
})

ok('samples: the first groups found, each listing up to 3 removed rows; largest is the biggest', () => {
  const keys: string[] = []
  for (let g = 0; g < 8; g++) keys.push(`g${g}`, `g${g}`)
  for (let i = 0; i < 6; i++) keys.push('big')
  const r = find('first', keys)
  assert.equal(r.samples.length, 5)
  assert.deepEqual(r.samples.map(s => s.size), [2, 2, 2, 2, 2])
  assert.equal(r.largest!.size, 6)
  const big = find('first', Array(9).fill('x'))
  assert.equal(big.samples[0].removed.length, 3)
  assert.equal(big.remove.length, 8)
})

if (failures > 0) { console.error(`${failures} dedupe assertion(s) failed`); process.exit(1) }
console.log('All dedupe assertions passed.')

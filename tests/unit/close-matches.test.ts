// The close matches an MCP error suggests (lib/close-matches.ts): an item matches by any of its keys (its
// name, its id), case, spaces and punctuation aside; the same key first, then one inside the other, then a
// few typos (a swap of two letters is one), never a far one; at most three. suggestColumn shares the edits.
// With a most, the edits answer the same up to it and one more past it, working only near the diagonal.
import assert from 'node:assert/strict'
import mod from '../../server/src/lib/close-matches'
import refMod from '../../server/src/lib/column-ref-resolve'
const { closeMatches, editDistance } = mod as typeof import('../../server/src/lib/close-matches')
const { suggestColumn } = refMod as typeof import('../../server/src/lib/column-ref-resolve')

let failures = 0
const check = (label: string, fn: () => void) => {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const sheets = [
  { id: 'c2f1a9e4-5b7d-4e21-9a3c-1f0e8d7b6a54', name: 'Leads' },
  { id: '0b9e7d6c-3a2f-4f18-8e5d-7c6b5a4f3e21', name: 'Leads 2024' },
  { id: '5e4d3c2b-1a09-4f87-b6a5-948372615f0e', name: 'Company Names' },
  { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'Invoices' },
]
const named = (given: string) => closeMatches(given, sheets, s => [s.name, s.id]).map(s => s.name)

check('edits: added, dropped, changed, and a swap of two letters next to each other counts once', () => {
  assert.deepEqual([editDistance('email', 'emails'), editDistance('email', 'emal'), editDistance('email', 'emoil'),
    editDistance('emial', 'email'), editDistance('', 'abc'), editDistance('abc', 'abc')], [1, 1, 1, 1, 3, 0])
})

// The edits worked out in full, every cell: what the banded one must agree with.
function fullEdits(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i + j))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      const swapped = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
      if (swapped) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}
let seed = 11
const pick = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n }
const word = (n: number, from = 'abc') => Array.from({ length: n }, () => from[pick(from.length)]).join('')

check('with a most: the same edits up to it, one more past it, on 3,000 random pairs', () => {
  for (let k = 0; k < 3000; k++) {
    const a = word(pick(13)), b = pick(2) ? word(pick(13)) : a.slice(0, pick(a.length + 1)) + word(pick(3))
    const full = fullEdits(a, b)
    assert.equal(editDistance(a, b), full, `${a} ${b}`)
    for (const most of [0, 1, 2, 3, 5]) {
      assert.equal(editDistance(a, b, most), Math.min(full, most + 1), `${a} ${b} ${most}`)
    }
  }
})

check('with a most, the work is the length times the band, not the length squared', () => {
  const a = word(4000, 'abcdefghijklmnopqrstuvwxyz')
  const b = `${a.slice(0, 1000)}#${a.slice(1001, 3000)}${a[3001]}${a[3000]}${a.slice(3002)}`
  const time = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t }
  assert.equal(editDistance(a, b, 3), 2)
  const banded = Math.min(...[1, 2, 3, 4, 5].map(() => time(() => editDistance(a, b, 3))))
  const whole = time(() => editDistance(a, b))
  assert.ok(banded * 20 < whole, `${banded.toFixed(2)} ms with a most of 3, ${whole.toFixed(2)} ms in full`)
})

check('a name sent as an id finds that name alone; part of a name finds the names holding it', () => {
  assert.deepEqual(named('Leads'), ['Leads'])
  assert.deepEqual(named('leads'), ['Leads'])
  assert.deepEqual(named('Lead'), ['Leads', 'Leads 2024'])
})

check('case, spaces and punctuation aside: company_name, companyNames and "Company names" are one', () => {
  for (const given of ['company_names', 'companyNames', 'Company names ']) {
    assert.deepEqual(named(given), ['Company Names'])
  }
})

check('a typo or two in a longer name, a swap, and a cut or mistyped id', () => {
  assert.deepEqual(named('Invoces'), ['Invoices'])
  assert.deepEqual(named('Inovices'), ['Invoices'])
  assert.deepEqual(named('c2f1a9e4-5b7d-4e21-9a3c-1f0e8d7b6a5'), ['Leads'])
  assert.deepEqual(named('a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e'), ['Invoices'])
  // Random ids are never a few edits apart, so another one never comes up.
  assert.deepEqual(named('d4c3b2a1-6f5e-4b7a-9d8c-5d4c3b2a1f0e'), [])
})

check('nothing close: none, and a short text never matches by being inside a name', () => {
  assert.deepEqual(named('Payroll'), [])
  assert.deepEqual(named('ea'), [])
  assert.deepEqual(named(''), [])
})

check('at most limit, closest first, in the given order among equals', () => {
  const items = ['abc12', 'abc1', 'abc2', 'abc3', 'abc4'].map(name => ({ name }))
  assert.deepEqual(closeMatches('abc', items, i => [i.name]).map(i => i.name), ['abc1', 'abc2', 'abc3'])
  assert.deepEqual(closeMatches('abc', items, i => [i.name], 1).map(i => i.name), ['abc1'])
})

check('suggestColumn reads the same edits: a swap now finds its column', () => {
  assert.equal(suggestColumn('Emial', ['Name', 'Email']), ' Did you mean "Email"?')
  assert.equal(suggestColumn('Payroll', ['Name', 'Email']), '')
})

if (failures) { console.error(`${failures} close-matches check(s) failed`); process.exit(1) }
console.log('All close-matches assertions passed.')

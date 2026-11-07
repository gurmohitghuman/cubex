// max_chars_per_cell's cutting (lib/row-select/cut-cells.ts, pure): text cut
// to N UTF-16 code units (String.length, as every cap in Cubex counts), one
// fewer when the cut would split a surrogate pair, so an emoji never comes back
// as a broken half; numbers, true/false and null never cut; an object or list
// (a value a columns path took out of a JSON cell) cut as its JSON text; a run
// cell's {status, value, error} has its value, error or reason cut and never its
// status; a row's cut cells listed in key order as column → full length (null
// when none), and a column named "__proto__" or "constructor" still a cell and a
// plain key of that list (a null-prototype object).
import assert from 'node:assert/strict'
import cutMod from '../../server/src/lib/row-select/cut-cells'
const { cutChars, cutCell, cutRow } = cutMod as typeof import('../../server/src/lib/row-select/cut-cells')

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
// No lone surrogate anywhere: every high one followed by a low one, every low one preceded by a high one.
const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)

check('text at or under the cut comes back as it is', () => {
  assert.equal(cutChars('hello', 5), 'hello')
  assert.equal(cutChars('hello', 200_000), 'hello')
  assert.equal(cutChars('', 1), '')
  assert.equal(cutCell('hello', 5), null)
})

check('longer text keeps its first N characters', () => {
  assert.equal(cutChars('abcdefghij', 4), 'abcd')
  assert.equal(cutChars('abcdefghij', 1), 'a')
  assert.deepEqual(cutCell('abcdefghij', 3), { value: 'abc', full: 10 })
  // Characters as String.length counts them: é is one, a BMP symbol one.
  assert.equal(cutChars('éééé', 2), 'éé')
  assert.equal(cutChars('✅✅✅', 2), '✅✅')
})

check('a cut never splits a surrogate pair: the emoji goes whole or not at all', () => {
  const s = 'ab😀cd' // a, b, \ud83d, \ude00, c, d
  assert.equal(s.length, 6)
  assert.equal(cutChars(s, 3), 'ab', 'the cut would end on the high half: one fewer')
  assert.equal(cutChars(s, 4), 'ab😀', 'the cut ends after the pair')
  assert.equal(cutChars(s, 2), 'ab')
  assert.equal(cutChars('😀😀😀', 1), '', 'nothing fits but half an emoji: nothing')
  assert.equal(cutChars('😀😀😀', 3), '😀')
  assert.deepEqual(cutCell('😀😀😀', 3), { value: '😀', full: 6 })
  // An emoji built from several characters can lose its last parts: a skin tone, a flag's second letter.
  assert.equal(cutChars('👍🏽', 2), '👍')
  assert.equal(cutChars('🇫🇷', 2), '🇫')
  // Every N over a text of mixed pairs and single units: well formed, never longer than N, a prefix.
  const mixed = 'a😀bc🎉🎉d👍🏽e'.repeat(3)
  for (let n = 1; n <= mixed.length + 1; n++) {
    const cut = cutChars(mixed, n)
    assert.ok(wellFormed(cut), `n=${n}: ${JSON.stringify(cut)}`)
    assert.ok(cut.length <= n && cut.length >= Math.min(n, mixed.length) - 1, `n=${n}: length ${cut.length}`)
    assert.ok(mixed.startsWith(cut), `n=${n}`)
  }
})

check('a lone high surrogate at the cut is dropped too', () => {
  assert.equal(cutChars('ab\ud83dcd', 3), 'ab')
})

check('numbers, true/false and null are never cut', () => {
  assert.equal(cutCell(12345678901234, 3), null)
  assert.equal(cutCell(true, 1), null)
  assert.equal(cutCell(false, 1), null)
  assert.equal(cutCell(null, 1), null)
  assert.equal(cutCell(undefined, 1), null)
})

check('an object or list is measured and cut as its JSON text', () => {
  const obj = { emails: ['a@b.co', 'c@d.co'], ok: true }
  const json = JSON.stringify(obj)
  assert.equal(cutCell(obj, json.length), null, 'its JSON fits: the object as it is')
  assert.deepEqual(cutCell(obj, 10), { value: json.slice(0, 10), full: json.length })
  assert.deepEqual(cutCell([1, 2, 3], 4), { value: '[1,2', full: 7 })
  // JSON stored as text is text: cut like any other.
  assert.deepEqual(cutCell(json, 10), { value: json.slice(0, 10), full: json.length })
})

check('a run cell read with include_status: its value, error or reason cut, never its status', () => {
  const done = { status: 'done', value: 'x'.repeat(50), error: null }
  assert.deepEqual(cutCell(done, 10, true), { value: { status: 'done', value: 'x'.repeat(10), error: null }, full: 50 })
  const failed = { status: 'error', value: null, error: 'HTTP 404 Not Found: the page is gone' }
  assert.deepEqual(cutCell(failed, 8, true), { value: { status: 'error', value: null, error: 'HTTP 404' }, full: 36 })
  const noResult = { status: 'no_result', value: null, error: null, reason: 'Budget ran out' }
  assert.deepEqual(cutCell(noResult, 6, true),
    { value: { status: 'no_result', value: null, error: null, reason: 'Budget' }, full: 14 })
  // A status word is never cut, however short N is; a cell with nothing long comes back as it is.
  assert.equal(cutCell({ status: 'condition_not_met', value: null, error: null }, 1, true), null)
  assert.equal(cutCell({ status: 'done', value: 'short', error: null }, 5, true), null)
  // The same object read as a plain value (a columns path's) is cut as its JSON text.
  assert.equal(typeof cutCell(done, 10, false)?.value, 'string')
})

check('a row: its cells cut and listed in key order, short ones and non-text left alone', () => {
  const data = { A: 'a'.repeat(20), B: 'short', C: 42, D: 'd'.repeat(12), E: { status: 'done', value: 'e'.repeat(30) } }
  const out = cutRow(data, 10, new Set(['E']))
  assert.deepEqual(out.data, { A: 'a'.repeat(10), B: 'short', C: 42, D: 'd'.repeat(10),
    E: { status: 'done', value: 'e'.repeat(10) } })
  assert.deepEqual({ ...out.cut }, { A: 20, D: 12, E: 30 })
  assert.deepEqual(Object.keys(out.cut!), ['A', 'D', 'E'], 'the cut columns in the row\'s order')
  assert.equal(Object.getPrototypeOf(out.cut), null)
  assert.deepEqual(Object.keys(out.data), ['A', 'B', 'C', 'D', 'E'], 'the columns keep their order')
  assert.equal(data.A.length, 20, 'the row read is left as it was')
  assert.deepEqual(cutRow({ A: 'x' }, 10, new Set()), { data: { A: 'x' }, cut: null })
})

check('columns named "__proto__" and "constructor" stay cells and plain keys of the list', () => {
  const long = 'p'.repeat(20)
  const data: Record<string, unknown> = JSON.parse(`{"__proto__":"${long}","constructor":"${long}","toString":"t"}`)
  const out = cutRow(data, 5, new Set())
  assert.ok(Object.prototype.hasOwnProperty.call(out.data, '__proto__'))
  assert.equal(out.data['__proto__'], 'ppppp')
  assert.equal(Object.getPrototypeOf(out.data), Object.prototype)
  const cut = out.cut!
  assert.deepEqual(Object.keys(cut), ['__proto__', 'constructor'])
  assert.equal(cut['__proto__'], 20)
  assert.equal(cut['constructor'], 20)
  assert.ok(!('toString' in cut), 'nothing inherited: a short "toString" cell is not listed')
  assert.equal(JSON.stringify(cut), '{"__proto__":20,"constructor":20}')
  assert.deepEqual(JSON.parse(JSON.stringify(cut)), JSON.parse('{"__proto__":20,"constructor":20}'))
})

if (failures) { console.error(`${failures} read-cut-cells check(s) failed`); process.exit(1) }
console.log('All read-cut-cells assertions passed.')

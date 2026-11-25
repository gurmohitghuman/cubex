// fix_encoding costs about the same per character on any cell: a 200,000-
// character cell (the largest a run writes) of text it leaves as it is, or of
// text it repairs, takes well under CELL_MS, and the import's check on it is
// cheaper still. A made-up chain of sequences at the head of such a cell
// doesn't multiply that: the whole repair gets FIX_ENCODING_MAX_ROUNDS rounds,
// and a round after a pass's first works out again only the group the chain is
// in. Of real text, Japanese text with units garbled once costs most: in the
// first pass nothing between its sequences ends a word, so each round reads the
// whole cell (about four readings, under twice CELL_MS). Made-up chains and
// units can cost as much: one repeated unit used to set off a round per unit,
// until a round could only leave more sequences as they are; the chain took
// 106 to 124 ms against CELL_MS on a busy machine. Hebrew text with
// abbreviations of single letters costs no more than other garbled text.
// The best of a few tries counts, so a busy machine doesn't decide it.
import assert from 'node:assert/strict'
import passMod from '../../server/src/lib/clean/fix-encoding-pass'
import { cp1252, finish, fixEncoding, group, looksGarbled } from './fix-encoding-kit'
// The most one such cell may take: a fill's slice works out one row at least, however long it takes
// (services/derived-write.ts).
const CELL_MS = 100
const { repairOnce } = passMod as typeof import('../../server/src/lib/clean/fix-encoding-pass')

const SIZE = 200_000
const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)
const GERMAN = 'Straße \u201EGroß\u201C und Maß\u2026 '
// 23 characters of made-up sequences: worked out with no cap, every pass takes
// 3 rounds and a fourth would still decode, so the value stays as it came.
const CHAIN = '\u00C2\u00C3\u0192\u0082\u2030\u009D\u00CF\u00AE\u00C5\u0080\u00EC\u0092'
  + '\u008D\u00C6\u0080\u00EA\u203A\u0087\u0178\u0085\u0096\u00CB\u00F3'
const best = (fn: () => void) => {
  let ms = Infinity
  for (let tries = 0; tries < 5; tries++) {
    const t = performance.now()
    fn()
    ms = Math.min(ms, performance.now() - t)
  }
  return ms
}

await group('a long cell it leaves as it is (German, ß before quotes and dots)', () => {
  const cell = fill(GERMAN)
  let out = ''
  const ms = best(() => { out = fixEncoding(cell) })
  const check = best(() => looksGarbled(cell))
  console.log(`      fixEncoding ${ms.toFixed(1)} ms, looksGarbled ${check.toFixed(2)} ms`)
  assert.equal(out, cell)
  assert.ok(ms < CELL_MS, `fixEncoding took ${ms.toFixed(1)} ms`)
  assert.ok(check < CELL_MS / 10, `looksGarbled took ${check.toFixed(2)} ms`)
})

await group('a long garbled cell it repairs', () => {
  const words = 'Müller \u201EGröße\u201C \u2013 São Paulo\u2026 '
  const cell = fill(cp1252(words))
  let out = ''
  const ms = best(() => { out = fixEncoding(cell) })
  const check = best(() => looksGarbled(cell))
  console.log(`      fixEncoding ${ms.toFixed(1)} ms, looksGarbled ${check.toFixed(2)} ms`)
  assert.ok(out.startsWith(words.repeat(3)), out.slice(0, 80))
  assert.ok(ms < CELL_MS, `fixEncoding took ${ms.toFixed(1)} ms`)
  assert.ok(check < CELL_MS / 10, `looksGarbled took ${check.toFixed(2)} ms`)
})

await group('a made-up chain of sequences at the head of the long cell, as it is and garbled twice', () => {
  for (const [name, rest] of [['German', fill(GERMAN)], ['German garbled twice', fill(cp1252(cp1252(GERMAN)))]]) {
    const cell = CHAIN + rest
    let out = ''
    const ms = best(() => { out = fixEncoding(cell) })
    console.log(`      ${name}: fixEncoding ${ms.toFixed(1)} ms`)
    assert.equal(out, cell, `${name}: left as it came`)
    assert.ok(ms < 2 * CELL_MS, `${name}: fixEncoding took ${ms.toFixed(1)} ms`)
  }
})

await group('a long cell of Japanese text with units, garbled once (nothing between its sequences ends a word)', () => {
  const cell = fill(cp1252('抵抗10kΩ、容量100μF、USBケーブル。'))
  let out = ''
  const ms = best(() => { out = fixEncoding(cell) })
  console.log(`      fixEncoding ${ms.toFixed(1)} ms`)
  assert.equal(out, cell, 'left as it came: "10kΩ" and "100μF" mix scripts, and their C1 characters stay')
  assert.ok(ms < 2 * CELL_MS, `fixEncoding took ${ms.toFixed(1)} ms`)
})

await group('a long cell of Hebrew text with abbreviations, garbled once', () => {
  const words = 'מחיר 100 ש"ח לק"ג, א, ב, ג (א) בע"מ שלום '
  const cell = fill(cp1252(words))
  let out = ''
  const ms = best(() => { out = fixEncoding(cell) })
  console.log(`      fixEncoding ${ms.toFixed(1)} ms`)
  assert.ok(out.startsWith(words.repeat(3)), out.slice(0, 80))
  assert.ok(ms < CELL_MS, `fixEncoding took ${ms.toFixed(1)} ms`)
})

await group('a long cell of one made-up unit repeated (each round left the next unit free to decode)', () => {
  const cell = fill('\u2013\u00E6\u2013\u2013A\u017D\u00B9\u0153\u00EF\u02C6\u00B0\u00C4')
  let out = ''
  const ms = best(() => { out = fixEncoding(cell) })
  console.log(`      fixEncoding ${ms.toFixed(1)} ms`)
  assert.ok(fixEncoding(out) === out, 'cleaning the answer again changes nothing')
  const rounds = { left: 100 }
  repairOnce(cell, rounds)
  assert.ok(100 - rounds.left <= 2, `the first pass took ${100 - rounds.left} rounds`)
  assert.ok(ms < 2 * CELL_MS, `fixEncoding took ${ms.toFixed(1)} ms`)
})

finish('fix-encoding-cost')

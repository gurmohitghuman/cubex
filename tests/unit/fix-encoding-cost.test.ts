// fix_encoding costs about the same per character on any cell: a 200,000-
// character cell (the largest a run writes) of text it leaves as it is, or of
// text it repairs, takes well under one fill slice (DERIVED_SLICE_MS), and the
// import's check on it is cheaper still. A made-up chain of sequences at the
// head of such a cell doesn't multiply that: the whole repair gets
// FIX_ENCODING_MAX_ROUNDS rounds, and a round after a pass's first works out
// again only the group the chain is in. Japanese text with units garbled once
// costs most: in the first pass nothing between its sequences ends a word, so
// each round reads the whole cell (about four readings, under two slices). The
// best of a few tries counts, so a busy machine doesn't decide it.
import assert from 'node:assert/strict'
import constantsMod from '../../server/src/lib/constants-clean'
import { cp1252, finish, fixEncoding, group, looksGarbled } from './fix-encoding-kit'
const { DERIVED_SLICE_MS } = constantsMod as typeof import('../../server/src/lib/constants-clean')

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
  assert.ok(ms < DERIVED_SLICE_MS, `fixEncoding took ${ms.toFixed(1)} ms`)
  assert.ok(check < DERIVED_SLICE_MS / 10, `looksGarbled took ${check.toFixed(2)} ms`)
})

await group('a long garbled cell it repairs', () => {
  const words = 'Müller \u201EGröße\u201C \u2013 São Paulo\u2026 '
  const cell = fill(cp1252(words))
  let out = ''
  const ms = best(() => { out = fixEncoding(cell) })
  const check = best(() => looksGarbled(cell))
  console.log(`      fixEncoding ${ms.toFixed(1)} ms, looksGarbled ${check.toFixed(2)} ms`)
  assert.ok(out.startsWith(words.repeat(3)), out.slice(0, 80))
  assert.ok(ms < DERIVED_SLICE_MS, `fixEncoding took ${ms.toFixed(1)} ms`)
  assert.ok(check < DERIVED_SLICE_MS / 10, `looksGarbled took ${check.toFixed(2)} ms`)
})

await group('a made-up chain of sequences at the head of the long cell, as it is and garbled twice', () => {
  for (const [name, rest] of [['German', fill(GERMAN)], ['German garbled twice', fill(cp1252(cp1252(GERMAN)))]]) {
    const cell = CHAIN + rest
    let out = ''
    const ms = best(() => { out = fixEncoding(cell) })
    console.log(`      ${name}: fixEncoding ${ms.toFixed(1)} ms`)
    assert.equal(out, cell, `${name}: left as it came`)
    assert.ok(ms < DERIVED_SLICE_MS, `${name}: fixEncoding took ${ms.toFixed(1)} ms`)
  }
})

await group('a long cell of Japanese text with units, garbled once (nothing between its sequences ends a word)', () => {
  const cell = fill(cp1252('抵抗10kΩ、容量100μF、USBケーブル。'))
  let out = ''
  const ms = best(() => { out = fixEncoding(cell) })
  console.log(`      fixEncoding ${ms.toFixed(1)} ms`)
  assert.equal(out, cell, 'left as it came: "10kΩ" and "100μF" mix scripts, and their C1 characters stay')
  assert.ok(ms < 2 * DERIVED_SLICE_MS, `fixEncoding took ${ms.toFixed(1)} ms`)
})

finish('fix-encoding-cost')

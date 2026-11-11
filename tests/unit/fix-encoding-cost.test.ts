// fix_encoding costs about the same per character on any cell: a 200,000-
// character cell (the largest a run writes) of text it leaves as it is, or of
// text it repairs, takes well under one fill slice (DERIVED_SLICE_MS), and the
// import's check on it is cheaper still. The best of a few rounds counts, so a
// busy machine doesn't decide it.
import assert from 'node:assert/strict'
import constantsMod from '../../server/src/lib/constants-clean'
import { cp1252, finish, fixEncoding, group, looksGarbled } from './fix-encoding-kit'
const { DERIVED_SLICE_MS } = constantsMod as typeof import('../../server/src/lib/constants-clean')

const SIZE = 200_000
const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE)
const best = (fn: () => void) => {
  let ms = Infinity
  for (let round = 0; round < 5; round++) {
    const t = performance.now()
    fn()
    ms = Math.min(ms, performance.now() - t)
  }
  return ms
}

await group('a long cell it leaves as it is (German, ß before quotes and dots)', () => {
  const cell = fill('Straße \u201EGroß\u201C und Maß\u2026 ')
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

finish('fix-encoding-cost')

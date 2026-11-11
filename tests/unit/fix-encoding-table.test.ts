// The one table of every case (fix-encoding-cases.ts): for each value and form, what fix_encoding gives, whether
// the import counts it, and that cleaning the answer again changes nothing; each input once; and values with
// no sequence to decode, left as they are and not counted. Every failing row is listed.
import assert from 'node:assert/strict'
import { finish, fixEncoding, group, looksGarbled } from './fix-encoding-kit'
import { NOTHING_TO_DECODE, ROWS } from './fix-encoding-cases'
import bytesMod from '../../server/src/lib/clean/fix-encoding-bytes'
const { sequencesOf } = bytesMod as typeof import('../../server/src/lib/clean/fix-encoding-bytes')

const hidden = (c: number) => c < 0x20 || (c >= 0x7F && c <= 0xA0) || (c >= 0x2000 && c <= 0x200F)
  || (c >= 0x2028 && c <= 0x202F) || c === 0xFEFF
const show = (s: string) => JSON.stringify([...s].map(ch => {
  const c = ch.codePointAt(0)!
  return hidden(c) ? `<${c.toString(16).toUpperCase().padStart(4, '0')}>` : ch
}).join(''))

await group(`${ROWS.length} rows: what fix_encoding gives, whether the import counts it, cleaning again`, () => {
  const wrong = ROWS.flatMap(r => {
    const out = fixEncoding(r.input)
    const counted = looksGarbled(r.input)
    return [
      ...(out === r.want ? [] : [`${r.why}: ${show(r.input)} gave ${show(out)}, not ${show(r.want)}`]),
      ...(counted === r.counted ? [] : [`${r.why}: ${show(r.input)} ${counted ? 'counted' : 'not counted'}`]),
      ...(fixEncoding(out) === out ? [] : [`${r.why}: cleaning ${show(out)} again changes it`]),
    ]
  })
  assert.deepEqual(wrong, [])
})

await group('each input once, in one list', () => {
  const inputs = [...ROWS.map(r => r.input), ...NOTHING_TO_DECODE]
  assert.deepEqual(inputs.filter((v, i) => inputs.indexOf(v) !== i).map(show), [])
})

await group(`${NOTHING_TO_DECODE.length} values with nothing to decode: left as they are, not counted`, () => {
  const wrong = NOTHING_TO_DECODE.flatMap(v => [
    ...(sequencesOf(v).length === 0 ? [] : [`${show(v)} holds a sequence: it belongs in the rows`]),
    ...(fixEncoding(v) === v ? [] : [`${show(v)} gave ${show(fixEncoding(v))}`]),
    ...(looksGarbled(v) ? [`${show(v)} counted`] : []),
  ])
  assert.deepEqual(wrong, [])
})

finish('fix-encoding-table')

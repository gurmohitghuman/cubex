// Time-ordered row ids (lib/ordered-id.ts): UUID-shaped (version 7, RFC 9562
// variant), unique, and always increasing as text: in one millisecond, past
// 4,096 in one millisecond, and when the clock is set back.
import assert from 'node:assert/strict'
import idMod from '../../server/src/lib/ordered-id'
import constMod from '../../server/src/lib/constants'
const { orderedUuid } = idMod as typeof import('../../server/src/lib/ordered-id')
const { UUID_PATTERN } = constMod as typeof import('../../server/src/lib/constants')

const ids: string[] = []
const now = Date.now()
for (let i = 0; i < 10_000; i++) ids.push(orderedUuid(now))       // one millisecond, past 4,096
for (let i = 0; i < 100; i++) ids.push(orderedUuid(now - 60_000)) // the clock set back a minute
for (let i = 0; i < 1_000; i++) ids.push(orderedUuid())
for (const id of ids) {
  assert.match(id, UUID_PATTERN)
  assert.equal(id[14], '7', 'version 7')
  assert.ok('89ab'.includes(id[19]), 'RFC 9562 variant')
}
assert.equal(new Set(ids).size, ids.length, 'unique')
for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1] < ids[i], `increasing at ${i}: ${ids[i - 1]} ${ids[i]}`)
const ms = (id: string) => parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
assert.ok(Math.abs(ms(ids[0]) - now) <= 1, 'the first id carries the time')
console.log('all ordered id checks passed')

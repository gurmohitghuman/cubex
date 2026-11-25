// How deep a parsed body nests (lib/json-depth.ts): 64 levels pass, 65 are refused, in arrays or objects; a wide
// body is not deep; and 100,000 levels are walked without overflowing the stack.
import assert from 'node:assert/strict'
import depthMod from '../../server/src/lib/json-depth'
const { jsonTooDeep, MAX_JSON_DEPTH } = depthMod as typeof import('../../server/src/lib/json-depth')

const arrays = (n: number) => { let v: unknown = 1; for (let i = 0; i < n; i++) v = [v]; return v }
const objects = (n: number) => { let v: unknown = 'x'; for (let i = 0; i < n; i++) v = { a: v }; return v }
assert.equal(MAX_JSON_DEPTH, 64)
assert.equal(jsonTooDeep(arrays(64)), false)
assert.equal(jsonTooDeep(arrays(65)), true)
assert.equal(jsonTooDeep(objects(64)), false)
assert.equal(jsonTooDeep({ b: objects(64) }), true)
console.log('ok   64 levels pass, 65 are refused, in arrays and objects')
assert.equal(jsonTooDeep(Array.from({ length: 10_000 }, (_, i) => ({ i, v: [i, { w: i }] }))), false)
assert.equal(jsonTooDeep(null), false)
assert.equal(jsonTooDeep('text'), false)
console.log('ok   a wide body, null and a string are not deep')
assert.equal(jsonTooDeep(arrays(100_000)), true)
console.log('ok   100,000 levels: refused, no stack overflow')

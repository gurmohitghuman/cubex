// The path dialect end to end: a path the client builds (json-mapping/jsonPath.ts)
// is read by the server (lib/jsonpath-literal.ts via extractOutcome) as exactly
// the key it was built from, whatever the key holds; ordinary paths read the same
// as jsonpath-plus read them; `*` and `..` paths still go to jsonpath-plus.
// Hidden characters are built at runtime, never typed. Seeded: the same cases each run.
import { JSONPath } from 'jsonpath-plus'
import extractMod from '../../server/src/lib/jsonpath-extract'
import literalMod from '../../server/src/lib/jsonpath-literal'
import pathsMod from '../../server/src/lib/answer-paths'
import {
  appendIndex, appendKey, escapeKey, unescapeKey as clientUnescape,
} from '../../client/src/components/json-mapping/jsonPath'
import * as readPath from '../../client/src/components/json-mapping/readPath'
import { extractByJsonPath } from '../../client/src/components/http-modal/cell-helpers'

const { extractOutcome, validateHttpJsonPath, validateMappingPath } = extractMod
const { literalSteps, samePath, unescapeKey } = literalMod
const { parsePath } = pathsMod

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const ch = (...codes: number[]) => String.fromCharCode(...codes)
let seed = 7
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// --- Keys jsonpath-plus misread now read as themselves ------------------------------
const awkward = [
  '@odata.context', '@odata.nextLink', '@type', '@id', "user's name", 'a^b', '*', 'a,b', '$', '..', 'a"b', 'a' + ch(92)
    + 'b', '$ref', 'a[0]', ']', '[', 'x;y', '%@%', '#1', '`x', 'a:b', '~', 'line1' + ch(10) + 'line2', 'tab' + ch(9),
  ch(0x202e) + 'evil', 'zw' + ch(0x200b), 'tag' + ch(0xdb40, 0xdc41), 'lone' + ch(0xd800), '', '0', '01', '__proto__',
  'constructor', 'first name', 'event.type', 'x-id', 'emoji ' + ch(0xd83d, 0xde00), ch(92) + 'u0041',
]
const doc = JSON.parse(JSON.stringify(Object.fromEntries(awkward.map((k, i) => [k, `v${i}`]))))
// JSON.parse makes __proto__ an own key, as a real reply would.
const parsedProto = JSON.parse('{"__proto__": "v-proto", "nested": {"@type": "Person"}}')
let allRead = true
for (const [i, k] of awkward.entries()) {
  const path = appendKey('$', k)
  const got = extractOutcome({ outer: doc }, appendKey('$.outer', k))
  const top = extractOutcome(doc, path)
  if (!top.matched || top.value !== `v${i}` || !got.matched || got.value !== `v${i}`) {
    allRead = false
    console.log('     misread', JSON.stringify(k), path, JSON.stringify(top))
  }
}
check('every awkward key reads as itself, at the top and nested', allRead)
check('the HTTP dialog\'s preview reads them the same (Add N columns)', awkward.every((k, i) =>
  extractByJsonPath({ outer: doc }, appendKey('$.outer', k)) === `v${i}`)
  && extractByJsonPath({ data: { constructor: 1 } }, '$.data.constructor') === 1
  && extractByJsonPath({ data: {} }, '$.data.constructor') === undefined)
check('a JSON-parsed __proto__ key reads as its own value',
  extractOutcome(parsedProto, appendKey('$', '__proto__')).value === 'v-proto'
  && extractOutcome(parsedProto, '$.nested["@type"]').value === 'Person')
check('a missing key never reads the prototype', !extractOutcome({}, '$.constructor').matched
  && !extractOutcome({}, '$.__proto__').matched && !extractOutcome({}, '$.toString').matched)
check('the server takes every path the builder makes for them',
  awkward.every(k => validateHttpJsonPath(appendKey('$', k)).ok && validateMappingPath(appendKey('$', k)).ok))
// Controls, the override and zero-width space tested here, and any surrogate
// that isn't half of a pair.
function hasHidden(s: string): boolean {
  for (let n = 0; n < s.length; n++) {
    const c = s.charCodeAt(n)
    const pairHi = c >= 0xd800 && c <= 0xdbff && s.charCodeAt(n + 1) >= 0xdc00 && s.charCodeAt(n + 1) <= 0xdfff
    if (pairHi) { n++; continue }
    if (c < 0x20 || c === 0x202e || c === 0x200b || (c >= 0xd800 && c <= 0xdfff)) return true
  }
  return false
}
check('a copied path holds no hidden characters', awkward.every(k => !hasHidden(appendKey('$', k))))
check('...and the tag character is written out too', appendKey('$', 'tag' + ch(0xdb40, 0xdc41)).includes('DB40'))

// --- Escapes: client and server agree ------------------------------------------------
const units = [
  0, 9, 10, 13, 34, 92, 0x7f, 0x85, 0xad, 0x200b, 0x202e, 0x2028, 0xfeff, 0xd800, 0xdc00, 0x41, 0xe9, 0x6771,
]
let roundTrips = true
let agree = true
for (let n = 0; n < 3000; n++) {
  const key = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => ch(pick(units))).join('')
  if (unescapeKey(escapeKey(key)) !== key || clientUnescape(escapeKey(key)) !== key) roundTrips = false
  const any = Array.from({ length: 6 }, () => pick(['\\', 'u', '0', '0', '4', '1', 'n', 't', 'x', '"', 'q'])).join('')
  if (unescapeKey(any) !== clientUnescape(any)) agree = false
}
check('3,000 random keys survive escape then unescape, client and server', roundTrips)
check('client and server unescape any text the same way', agree)
check('an old path holding a raw newline still reads', extractOutcome({ ['a' + ch(10) + 'b']: 1 },
  '$["a' + ch(10) + 'b"]').value === 1)
check('the dropped-part check reads keys the same way',
  JSON.stringify(parsePath(appendKey('$.raw', '@type' + ch(10)))) === JSON.stringify([{ t: 'key', k: 'raw' },
    { t: 'key', k: '@type' + ch(10) }]))

// --- Ordinary paths read as jsonpath-plus read them -----------------------------------
const plainKeys = ['a', 'b', 'name', 'id', 'first name', 'x-id', 'event.type', '0', '1', 'length', 'items', 'k_2']
function randomValue(depth: number): unknown {
  const r = rand()
  if (depth > 3 || r < 0.3) return pick([1, 0, -2.5, 'Ada', '', 'xyz', null, true, false])
  if (r < 0.6) return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(depth + 1))
  const n = Math.floor(rand() * 4)
  return Object.fromEntries(Array.from({ length: n }, () => [pick(plainKeys), randomValue(depth + 1)]))
}
let differ = 0
let compared = 0
let hits = 0
for (let n = 0; n < 4000; n++) {
  const json = randomValue(0)
  // Mostly down keys and indexes the value has, sometimes ones it hasn't.
  let path = '$'
  let cur: any = json
  for (let d = 0; d < 1 + Math.floor(rand() * 4); d++) {
    const real = cur !== null && typeof cur === 'object' && rand() < 0.8
    if (real && Array.isArray(cur) && cur.length) {
      const i = Math.floor(rand() * cur.length); path = appendIndex(path, i); cur = cur[i]
    } else if (real && !Array.isArray(cur) && Object.keys(cur).length) {
      const k = pick(Object.keys(cur)); path = appendKey(path, k); cur = cur[k]
    } else {
      path = rand() < 0.5 ? appendKey(path, pick(plainKeys)) : appendIndex(path, Math.floor(rand() * 4)); cur = null
    }
  }
  if (rand() < 0.1) path += pick(['.length', '[01]', '[0]'])
  // jsonpath-plus answers undefined for a falsy reply: no match, as extractOutcome read it.
  const theirs = JSONPath({ path, json: json as any, eval: false }) as unknown[] | undefined
  const want = theirs?.length ? { matched: true, value: theirs[0] } : { matched: false, value: null }
  compared++
  if (want.matched) hits++
  const steps = readPath.literalSteps(path)
  const browser = steps ? readPath.readLiteral(json, steps) : { matched: false, value: 'not literal' }
  if (!same(extractOutcome(json, path), want) || !same(browser, want)) {
    differ++
    if (differ < 4) console.log('     differs', path, JSON.stringify(json), JSON.stringify(want))
  }
}
check(`${compared} random ordinary paths (${hits} found something) read exactly as jsonpath-plus read them, `
  + 'on the server and in the browser',
  differ === 0 && hits > compared / 10)

// --- Everything else still goes to jsonpath-plus --------------------------------------
const list = { results: [{ title: 'one' }, { title: 'two' }], deep: { title: 'three' } }
check('wildcards and recursive descent still work', extractOutcome(list, '$.results[*].title').value === 'one'
  && extractOutcome(list, '$..title').matched && extractOutcome(list, '$.results.*.title').value === 'one')
check('malformed paths are not read literally', [
  '$.', '$[', '$["a]', '$.a[b', 'a.b', '$.1a', '$[-1]', '$["a"]x', '$["a"', '$..a',
].every(p => literalSteps(p) === null))
check('the root reads the whole reply', same(extractOutcome(list, '$'), { matched: true, value: list }))
check('nothing is read out of an empty string, as jsonpath-plus', !extractOutcome({ s: '' }, '$.s.length').matched
  && !readPath.readLiteral({ s: '' }, ['s', 'length']).matched && extractOutcome({ s: 'ab' }, '$.s.length').value === 2)
check('a path that isn\'t text is not read literally', !extractOutcome({ a: 1 }, 7 as any).matched)
check('the same key written three ways is the same path', samePath('$["a' + ch(10) + 'b"]', appendKey('$', 'a' + ch(10)
  + 'b')) && readPath.pathKey('$["a' + ch(10) + 'b"]') === readPath.pathKey(appendKey('$', 'a' + ch(10) + 'b'))
  && samePath('$.items[0]', '$.items["0"]') && !samePath('$.a', '$.b') && samePath('$..a', '$..a')
  && !samePath('$..a', '$.a'))
check('a falsy reply matches nothing, as before', [0, false, '', null].every(v => !extractOutcome(v, '$').matched)
  && extractOutcome('str', '$[0]').value === 's' && extractOutcome([1, 2], '$.length').value === 2)

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall JSONPath dialect checks passed')

// The JSON tree's pure parts (client/src/components/json-mapping/tree-model.ts):
// what opens by itself and stays bounded on a big reply, how strings are cut,
// what hostile text looks like on screen, and which paths can become a column.
// Pure: no DB, no network. Hidden characters are built at runtime, never typed.
import {
  canMapPath, countLabel, cutText, openPaths, pageStarts, pathLabel, suggestedName, visibleText,
} from '../../client/src/components/json-mapping/tree-model'
import { appendKey } from '../../client/src/components/json-mapping/jsonPath'
import {
  JSON_PATH_MAX_CHARS, JSON_TREE_AUTO_OPEN_DEPTH, JSON_TREE_AUTO_OPEN_ROWS, JSON_TREE_EXPAND_ALL_DEPTH,
  JSON_TREE_EXPAND_ALL_ROWS, JSON_TREE_PAGE_ITEMS,
} from '../../client/src/lib/constants'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const ch = (...codes: number[]) => String.fromCharCode(...codes)
const BS = ch(92)
const root = (v: unknown) => [{ v, path: '$', depth: 0 }]
const autoOf = (v: unknown) =>
  openPaths(root(v), JSON_TREE_AUTO_OPEN_DEPTH, JSON_TREE_AUTO_OPEN_ROWS, JSON_TREE_PAGE_ITEMS)
const allOf = (v: unknown) =>
  openPaths(root(v), JSON_TREE_EXPAND_ALL_DEPTH, JSON_TREE_EXPAND_ALL_ROWS, JSON_TREE_PAGE_ITEMS)
const auto = (v: unknown) => autoOf(v).open
const all = (v: unknown) => allOf(v).open
// Generous: these guard against a quadratic slip, not a slow CI machine.
const FAST_MS = 2000

// --- Counts -----------------------------------------------------------------------
check('counts read as words', countLabel(1, true) === '1 item' && countLabel(5000, true) === '5,000 items'
  && countLabel(1, false) === '1 field' && countLabel(12, false) === '12 fields')

// --- What opens by itself -----------------------------------------------------------
const small = { user: { name: 'Ada', address: { city: 'Paris', geo: { lat: 1 } } }, tags: ['a', 'b'] }
const smallOpen = auto(small)
check('a small reply opens three levels deep', smallOpen.has('$') && smallOpen.has('$.user')
  && smallOpen.has('$.user.address') && smallOpen.has('$.tags') && !smallOpen.has('$.user.address.geo'))
check('empty containers and values never count as open', !auto({ a: [], b: {} }).has('$.a') && !auto('x').size)

const wide = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8,
  j: 9 })) }
const wideOpen = auto(wide)
check('the outer levels open before any inner one', wideOpen.has('$') && wideOpen.has('$.items')
  && wideOpen.has('$.items[0]'))
check('opening stops at the row budget', wideOpen.size < 30 && !wideOpen.has('$.items[99]'))

const huge = Array.from({ length: 200_000 }, (_, i) => ({ id: i, tags: ['x', 'y'] }))
let t0 = Date.now()
const hugeOpen = auto(huge)
const hugeMs = Date.now() - t0
check('a 200,000-item list: the root opens, only first-page children are looked at',
  hugeOpen.has('$') && [...hugeOpen].every(p => p === '$' || /^\$\[(\d+)\]/.test(p) && Number(/\d+/.exec(p)![0])
    < JSON_TREE_PAGE_ITEMS))
check(`...and it takes no time (${hugeMs} ms)`, hugeMs < FAST_MS)

const nested: any = {}
let cur = nested
for (let i = 0; i < 5000; i++) { cur.next = {}; cur = cur.next }
t0 = Date.now()
const deepAll = all(nested)
check('Expand all on a 5,000-deep chain stops at its depth, without recursion',
  deepAll.size === JSON_TREE_EXPAND_ALL_DEPTH && Date.now() - t0 < FAST_MS)
const grid = Array.from({ length: 1000 }, () => Array.from({ length: 1000 }, (_, j) => j))
t0 = Date.now()
const gridAll = all(grid)
check('Expand all on 1000 x 1000 stays within its row budget', gridAll.size <= JSON_TREE_EXPAND_ALL_ROWS / 10 + 1
  && Date.now() - t0 < FAST_MS)
check('paths use the same grammar as the mapping builder',
  auto({ 'a.b': { 'first name': [{ x: 1 }] } }).has('$["a.b"]["first name"]'))

check('Expand all says when it opened everything, and when it stopped',
  allOf(small).complete && !allOf(nested).complete && !allOf(grid).complete && autoOf({ a: 1 }).complete)
const long = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, tags: ['x'] })) }
const page2 = openPaths(pageStarts(long.items, '$.items', 2, 100, JSON_TREE_PAGE_ITEMS), JSON_TREE_AUTO_OPEN_DEPTH,
  JSON_TREE_AUTO_OPEN_ROWS, JSON_TREE_PAGE_ITEMS).open
check('a later page opens the way the first did', page2.has('$.items[100]') && !page2.has('$.items[0]')
  && !page2.has('$.items[100].tags'))
check('a page lists its own children', pageStarts(long.items, '$.items', 2, 290, 100).map(s => s.path).join()
  === Array.from({ length: 10 }, (_, i) => `$.items[${290 + i}]`).join())

// --- Strings --------------------------------------------------------------------------
check('a short string is not cut', cutText('abc', 10).text === 'abc' && cutText('abc', 10).rest === 0)
check('a long one is cut, with what is left', cutText('abcdef', 4).text === 'abcd' && cutText('abcdef', 4).rest === 2)
const emoji = 'a' + ch(0xd83d, 0xde00) + 'b'
check('a cut never splits a surrogate pair', cutText(emoji, 2).text === 'a' && cutText(emoji, 2).rest === 3
  && cutText(emoji, 3).text === 'a' + ch(0xd83d, 0xde00))

// --- Hostile text -----------------------------------------------------------------------
const plain = 'Plain text, émigré, 東京, ' + ch(0xd83d, 0xde00)
check('plain text (accents, CJK, emoji) shows as it is', visibleText(plain) === plain)
check('newline, tab and CR show as JSON writes them',
  visibleText('a' + ch(10) + 'b' + ch(9) + 'c' + ch(13)) === `a${BS}nb${BS}tc${BS}r`)
check('a right-to-left override shows as an escape and reorders nothing',
  visibleText('invoice' + ch(0x202e) + 'fdp.exe') === `invoice${BS}u202Efdp.exe`)
check('NUL, DEL, C1, zero-width space, BOM, isolates and soft hyphen show',
  visibleText(ch(0, 0x7f, 0x85, 0x200b, 0xfeff, 0x2066, 0xad)) === [0, 0x7f, 0x85, 0x200b, 0xfeff, 0x2066, 0xad]
    .map(c => `${BS}u${c.toString(16).toUpperCase().padStart(4, '0')}`).join(''))
check('line and paragraph separators show', visibleText(ch(0x2028, 0x2029)) === `${BS}u2028${BS}u2029`)
check('lone surrogates show', visibleText('a' + ch(0xd800) + 'b' + ch(0xdc00)) === `a${BS}uD800b${BS}uDC00`
  && visibleText(ch(0xd800)) === `${BS}uD800`)
check('invisible tag characters show', visibleText('hi' + ch(0xdb40, 0xdc41)) === `hi${BS}u{E0041}`)
const family = ch(0xd83d, 0xdc68, 0x200d, 0xd83d, 0xdc69)
check('joiners inside emoji stay', visibleText(family) === family)
const acute = ch(0x301)
check('up to three stacked marks stay (Vietnamese, Hebrew, keycaps, a variation selector)',
  visibleText('e' + ch(0x302, 0x301)) === 'e' + ch(0x302, 0x301)
    && visibleText(ch(0x5d1, 0x5bc, 0x5b8, 0x591)) === ch(0x5d1, 0x5bc, 0x5b8, 0x591)
    && visibleText('1' + ch(0xfe0f, 0x20e3)) === '1'
    + ch(0xfe0f, 0x20e3) && visibleText(ch(0x2764, 0xfe0f)) === ch(0x2764, 0xfe0f))
check('a flood of stacked marks shows as escapes past the third',
  visibleText('Z' + acute.repeat(5) + 'a') === 'Z' + acute.repeat(3) + `${BS}u0301`.repeat(2) + 'a')
check('a run of variation selectors too', visibleText('d' + ch(0xfe0f).repeat(5)) === 'd' + ch(0xfe0f).repeat(3)
  + `${BS}uFE0F`.repeat(2))
const tag = (c: string) => ch(0xdb40, 0xdc00 + c.charCodeAt(0))
const england = ch(0xd83c, 0xdff4) + [...'gbeng'].map(tag).join('') + ch(0xdb40, 0xdc7f)
check('a subdivision flag stays a flag', visibleText('flag ' + england + '!') === 'flag ' + england + '!')
check('...but tags anywhere else, or too many after a flag, show',
  visibleText('x' + tag('a')) === `x${BS}u{E0061}`
    && visibleText(ch(0xd83c, 0xdff4) + [...'abcdefg'].map(tag).join('')
    + ch(0xdb40, 0xdc7f)).includes(`${BS}u{E0061}`))
check('fillers and blanks that look like spaces show', visibleText('a' + ch(0x3164) + 'b' + ch(0x2800) + 'c'
  + ch(0x034f) + 'd' + ch(0xffa0, 0x115f, 0x17b4, 0x180b)) === `a${BS}u3164b${BS}u2800c${BS}u034Fd${BS}uFFA0${BS}u115F`
  + `${BS}u17B4${BS}u180B`)
check('musical formatting characters show', visibleText(ch(0xd834, 0xdd73)) === `${BS}u{1D173}`)
check('a path label is short and visible', pathLabel('$.a' + 'x'.repeat(500), 20).length === 21
  && pathLabel('$["' + ch(0x202e) + '"]') === `$["${BS}u202E"]`)

// --- Columns ---------------------------------------------------------------------------
check('a path the server takes can become a column', canMapPath('$.' + 'a'.repeat(JSON_PATH_MAX_CHARS - 2)))
check('a longer one cannot', !canMapPath('$.' + 'a'.repeat(JSON_PATH_MAX_CHARS - 1)))
check('the suggested name is the last key', suggestedName('$.data["first name"]') === 'first name'
  && suggestedName('$.items[0].sku') === 'sku')
check('...without hidden characters, a line break as a space',
  suggestedName(appendKey('$', 'pay' + ch(0x202e) + 'roll' + ch(10) + 'date')) === 'payroll date')
check('...short enough for the server', suggestedName(appendKey('$', 'k'.repeat(5000))).length === 100)
check('...and never empty', suggestedName(appendKey('$', ch(0x202e, 0x200b))) === 'value')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall JSON tree model checks passed')

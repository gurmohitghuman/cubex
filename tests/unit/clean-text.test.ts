// Unit test for lib/clean/text.ts: trim, lower case and title case. Every case
// also cleans its own output again, which must change nothing (auto-run
// cleans rows again). server/src is type:commonjs → default-import + destructure under tsx.
import text from '../../server/src/lib/clean/text'
const { cleanTrim, cleanLowercase, cleanTitleCase } = text as typeof import('../../server/src/lib/clean/text')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
function expectClean(name: string, f: (v: string) => string, input: string, want: string) {
  const got = f(input)
  const note = got === want ? '' : ` (got ${JSON.stringify(got)})`
  check(`${name} ${JSON.stringify(input)} → ${JSON.stringify(want)}${note}`, got === want)
  check(`${name} idempotent on ${JSON.stringify(got)}`, f(got) === got)
}
// Built from code points so no invisible character hides in this file.
const cp = (...codes: number[]) => String.fromCodePoint(...codes)
const NBSP = cp(0xA0), ZWSP = cp(0x200B), ZWJ = cp(0x200D), ZWNJ = cp(0x200C), BOM = cp(0xFEFF)

// --- trim ------------------------------------------------------------------
const trims: [string, string][] = [
  ['  Acme   Corp  ', 'Acme Corp'],
  [`Acme${NBSP}Corp`, 'Acme Corp'],
  [`${BOM}john@acme.com`, 'john@acme.com'],
  [`John${ZWSP} Smith`, 'John Smith'],
  ['Line1\n\tLine2', 'Line1 Line2'],
  [`${cp(0x1F468)}${ZWJ}${cp(0x1F4BB)} dev`, `${cp(0x1F468)}${ZWJ}${cp(0x1F4BB)} dev`],
  ['   ', ''],
  ['', ''],
  // Added: other spaces and hidden characters.
  [`a${cp(0x2003)}b${cp(0x202F)}c${cp(0x3000)}d${cp(0x85)}e${cp(0x2028)}f`, 'a b c d e f'],
  [`Ac${cp(0xAD)}me${cp(0x2060)} Co${cp(0x180E)}rp`, 'Acme Corp'],
  [`x${cp(0x7)}y\r\nz`, 'xy z'],
  // Persian plural and Hindi half form: the (non-)joiner is spelling there.
  [`${cp(0x645, 0x6CC)}${ZWNJ}${cp(0x62E, 0x648, 0x627, 0x647, 0x645)}`,
    `${cp(0x645, 0x6CC)}${ZWNJ}${cp(0x62E, 0x648, 0x627, 0x647, 0x645)}`],
  [`${cp(0x915, 0x94D)}${ZWJ}${cp(0x937)}`, `${cp(0x915, 0x94D)}${ZWJ}${cp(0x937)}`],
  // ...but not between Latin letters.
  [`ab${ZWNJ}cd${ZWJ}ef`, 'abcdef'],
]
for (const [input, want] of trims) expectClean('trim', cleanTrim, input, want)
check('trim: not a string → blank', cleanTrim(undefined as unknown as string) === '')
const long = `${'word '.repeat(40_000)}end`
const t0 = Date.now()
check('trim: long text is kept whole', cleanTrim(`  ${long}  `) === long)
check('trim: long text is quick', Date.now() - t0 < 1000)

// --- lower case --------------------------------------------------------------
const lowers: [string, string][] = [
  ['  John.SMITH@Acme.COM ', 'john.smith@acme.com'],
  [`HELLO${NBSP} WORLD`, 'hello world'],
  ['ÉCOLE', 'école'],
  ['', ''],
]
for (const [input, want] of lowers) expectClean('lowercase', cleanLowercase, input, want)

// --- title case --------------------------------------------------------------
const titles: [string, string][] = [
  ['vp of sales', 'VP of Sales'],
  ['VP OF SALES', 'VP of Sales'],
  ['head of marketing', 'Head of Marketing'],
  ['ceo & co-founder', 'CEO & Co-Founder'],
  ['director of r&d', 'Director of R&D'],
  ['sr. manager, it', 'Sr. Manager, IT'],
  ['founder/ceo', 'Founder/CEO'],
  ['salt lake city', 'Salt Lake City'],
  ['winston-salem', 'Winston-Salem'],
  ["o'fallon", "O'Fallon"],
  ["it's", "It's"],
  ['iPhone developer', 'iPhone Developer'],
  ['isle of wight', 'Isle of Wight'],
  // "it" is always the acronym, wherever it stands; "It's" never is.
  ['it manager', 'IT Manager'],
  ['IT DIRECTOR', 'IT Director'],
  ['It', 'IT'],
  ["IT'S A DEAL", "It's a Deal"],
  // Added.
  ['', ''],
  ['the end of the road', 'The End of the Road'],
  ['works at eBay and HubSpot', 'Works at eBay and HubSpot'],
  ['SENIOR AWS ENGINEER', 'Senior Aws Engineer'],
  ['Senior AWS engineer', 'Senior AWS Engineer'],
  ['saas account executive', 'SaaS Account Executive'],
  ['editor-in-chief', 'Editor-in-Chief'],
  ['in-house counsel', 'In-House Counsel'],
  ['p&g brand manager', 'P&G Brand Manager'],
  ['emea sales (b2b)', 'EMEA Sales (B2B)'],
  ['1ST LINE SUPPORT', '1st Line Support'],
  ['Q4 PLANNING LEAD', 'Q4 Planning Lead'],
  ['visit acme.com today', 'Visit acme.com Today'],
  ['ÉCOLE NORMALE', 'École Normale'],
  ['  head   OF   growth ', 'Head of Growth'],
  ['what is it for', 'What Is IT For'],
]
for (const [input, want] of titles) expectClean('title', cleanTitleCase, input, want)

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall clean-text checks passed')

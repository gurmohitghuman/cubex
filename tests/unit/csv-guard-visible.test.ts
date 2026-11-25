// The CSV export's formula guard looks at the first visible character (lib/csv-safety.ts): past C1, spaces of
// every width, line feeds and the invisible characters, which spreadsheet apps skip before they decide a cell is
// a formula, and it takes the full-width and look-alike triggers too. The import takes exactly that quote back
// off, so export then import gives every value back byte for byte.
//
// Checked in Numbers 2026 on macOS (2026-11-24, simrg): a CSV of unguarded cells, each "1+1" after one of these,
// opened and read back. Evaluated to 2: "=", " =", "  =", NBSP "=", zero-width space "=", ideographic space "=",
// line feed "=", U+0085 "=", and full-width "=" (U+FF1D). Kept as text: BOM "=", "+", "@", and the full-width
// "+" and "@", the small "=" (U+FE66), the minus sign (U+2212) and the full-width "-" (Numbers takes no "+" or "@"
// formula; Excel and LibreOffice do). Every one of them is guarded here: the quote is hidden in the apps, and
// other apps and locales were reported to read the rest (OWASP's CSV injection guide; LibreOffice).
//
// The characters are built from their code points, so this file holds no invisible character itself.
import assert from 'node:assert/strict'
import safetyMod from '../../server/src/lib/csv-safety'
import parseMod from '../../server/src/lib/csv-import-parse'
const { escapeCsvCell, stripFormulaGuard } = safetyMod as typeof import('../../server/src/lib/csv-safety')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) {
    failures++
    console.log('FAIL', label, '\n ', (e as Error).message)
  }
}
const guarded = (v: string) => `"'${v.replace(/"/g, '""')}"`
const plain = (v: string) => `"${v.replace(/"/g, '""')}"`
const ch = (...codes: number[]) => String.fromCharCode(...codes)

const NBSP = ch(0xA0), ZWSP = ch(0x200B), BOM = ch(0xFEFF), NEL = ch(0x85), IDEO = ch(0x3000)
const FW_EQ = ch(0xFF1D), FW_AT = ch(0xFF20), MINUS = ch(0x2212)

// What an app skips before the formula, and the triggers, each by name.
const SKIPPED: Array<[string, string]> = [
  ['a space', ' '], ['two spaces', '  '], ['a line feed', '\n'], ['NBSP', NBSP], ['zero-width space', ZWSP],
  ['ZWNJ', ch(0x200C)], ['ZWJ', ch(0x200D)], ['word joiner', ch(0x2060)], ['BOM', BOM], ['en space', ch(0x2002)],
  ['thin space', ch(0x2009)], ['narrow NBSP', ch(0x202F)], ['ideographic space', IDEO],
  ['line separator', ch(0x2028)], ['NEL (C1)', NEL], ['NBSP then zero-width space then a space', `${NBSP}${ZWSP} `],
  ['NEL (C1) then a space', `${NEL} `], ['BOM then a space', `${BOM} `],
]
const TRIGGERS = ['=', '+', '-', '@', '\t', '\r',
  FW_EQ, ch(0xFF0B), ch(0xFF0D), FW_AT, ch(0xFE66), ch(0xFE62), ch(0xFE63), MINUS]

check('what Numbers evaluated is guarded: "=1+1" after each character it skips', () => {
  for (const lead of [' ', '  ', NBSP, ZWSP, IDEO, '\n', NEL]) {
    const v = `${lead}=1+1`
    assert.equal(escapeCsvCell(v), guarded(v), JSON.stringify(v))
  }
  assert.equal(escapeCsvCell(`${FW_EQ}1+1`), guarded(`${FW_EQ}1+1`), 'full-width =')
})

check('every trigger after every skipped character is guarded', () => {
  for (const [name, lead] of SKIPPED) for (const t of TRIGGERS) {
    const v = `${lead}${t}SUM(A1)`
    assert.equal(escapeCsvCell(v), guarded(v), `${name} then ${JSON.stringify(t)}`)
  }
})

check('each full-width or look-alike trigger is guarded at the start', () => {
  for (const t of TRIGGERS) assert.equal(escapeCsvCell(`${t}1+1`), guarded(`${t}1+1`), JSON.stringify(t))
  assert.equal(escapeCsvCell(`${FW_EQ}HYPERLINK("http://x")`), `"'${FW_EQ}HYPERLINK(""http://x"")"`)
  assert.equal(escapeCsvCell(`${FW_AT}SUM(A1)`), guarded(`${FW_AT}SUM(A1)`))
})

check('not formulas, left as they are: a plain number behind spaces, text behind spaces, spaces alone', () => {
  for (const v of [' -5', `${NBSP}+44`, '  3.14', ' 1e5', `${BOM}3.14`, ' abc', `${NBSP}Caf${ch(0xE9)}`,
    `${ZWSP}hello`, '   ', NBSP, ZWSP, 'a =1', `x${ZWSP}=1`, `abc${FW_EQ}`, '', '-5', '+44']) {
    assert.equal(escapeCsvCell(v), plain(v), JSON.stringify(v))
  }
  // A minus sign isn't ASCII, so "-5" written with it isn't a plain number to the export: it is guarded, the
  // quote hidden.
  assert.equal(escapeCsvCell(`${MINUS}5`), guarded(`${MINUS}5`))
})

check('a value that already starts with the guard gets one more, so the import gives it back whole', () => {
  for (const v of ["' =x", `'${NBSP}=x`, `'${ZWSP}@x`, `'${FW_EQ}x`, "'' =x", "'=already"]) {
    assert.equal(escapeCsvCell(v), guarded(v), JSON.stringify(v))
  }
  assert.equal(escapeCsvCell("' abc"), plain("' abc"))
})

check('the import takes exactly that quote off, and nothing else', () => {
  assert.equal(stripFormulaGuard("' =SUM(A1)"), ' =SUM(A1)')
  assert.equal(stripFormulaGuard(`'${NBSP}${ZWSP}=1`), `${NBSP}${ZWSP}=1`)
  assert.equal(stripFormulaGuard(`'${FW_EQ}1+1`), `${FW_EQ}1+1`)
  assert.equal(stripFormulaGuard("'\n@x"), '\n@x')
  assert.equal(stripFormulaGuard("'' =x"), "' =x")
  for (const v of ["' abc", `'${NBSP}`, "' ", "'a =1", "'"]) assert.equal(stripFormulaGuard(v), v, JSON.stringify(v))
})

// Export then import (the import takes the quote off as it reads, csv-import-parse.ts): byte for byte, for every
// skipped character and trigger above, and every value of 1 to 4 characters made of a quote, a space, NBSP, a
// zero-width space, the full-width "=", -, a digit and a letter.
const values: string[] = []
for (const [, lead] of SKIPPED) for (const t of TRIGGERS) values.push(`${lead}${t}1+1`, `'${lead}${t}1+1`)
values.push(' -5', `${NBSP}+44`, ' abc', "' abc", "'' =x", `${MINUS}5`, '=1+1', '-5', '', '   ',
  'a "quoted" =1', "'=already", 'plain', `${BOM}x`, `${NEL} -5`)
const ALPHABET = ["'", ' ', NBSP, ZWSP, FW_EQ, '-', '5', 'a']
let short = ['']
for (let n = 1; n <= 4; n++) {
  short = short.flatMap(v => ALPHABET.map(c => v + c))
  values.push(...short)
}
const csv = ['val', ...values.map(escapeCsvCell)].join('\r\n')
const back: string[] = []
for await (const row of (await scanCsvText(csv)).rows()) back.push(String(row.val))
check(`export then import gives every value back byte for byte (${values.length} values)`, () => {
  assert.equal(back.length, values.length)
  values.forEach((v, i) => assert.equal(back[i], v, `row ${i}: ${JSON.stringify(v)}`))
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('csv guard visible: all passed')

// The CSV export's formula guard looks past leading C1 characters (an app that
// drops them as it opens the file would see the formula), and the import takes
// exactly that quote back off, so export then import gives every value back
// byte for byte.
import assert from 'node:assert/strict'
import safetyMod from '../../server/src/lib/csv-safety'
import parseMod from '../../server/src/lib/csv-import-parse'
const { escapeCsvCell, stripFormulaGuard } = safetyMod as typeof import('../../server/src/lib/csv-safety')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const NEL = '\u0085', C1A = '\u0080', C1Z = '\u009F'

// Export: a trigger after leading C1 characters is guarded like one at the start.
for (const t of ['=', '+', '-', '@', '\t', '\r']) {
  assert.equal(escapeCsvCell(`${NEL}${t}SUM(A1)`), `"'${NEL}${t}SUM(A1)"`, `one C1 then ${JSON.stringify(t)}`)
  assert.equal(escapeCsvCell(`${C1A}${C1Z}${NEL}${t}1+1`), `"'${C1A}${C1Z}${NEL}${t}1+1"`, `three C1 then ${t}`)
}
assert.equal(escapeCsvCell(`${NEL}=HYPERLINK("http://x")`), `"'${NEL}=HYPERLINK(""http://x"")"`)
// Not a formula: C1 then a plain number, C1 then text, C1 alone, a C1 after the start.
assert.equal(escapeCsvCell(`${NEL}-5`), `"${NEL}-5"`)
assert.equal(escapeCsvCell(`${NEL}abc`), `"${NEL}abc"`)
assert.equal(escapeCsvCell(`${NEL}${C1A}`), `"${NEL}${C1A}"`)
assert.equal(escapeCsvCell(`a${NEL}=1`), `"a${NEL}=1"`)
// A value that already starts with the guard gets one more, so the import gives it back whole.
assert.equal(escapeCsvCell("'=x"), `"''=x"`)
assert.equal(escapeCsvCell("'-5"), `"''-5"`)
assert.equal(escapeCsvCell(`'${NEL}=x`), `"''${NEL}=x"`)
assert.equal(escapeCsvCell("'abc"), `"'abc"`)
assert.equal(escapeCsvCell("'"), `"'"`)
// Unchanged without C1.
assert.equal(escapeCsvCell('=1+1'), `"'=1+1"`)
assert.equal(escapeCsvCell('-5'), '"-5"')
assert.equal(escapeCsvCell(''), '""')

// Import: exactly that quote comes off.
assert.equal(stripFormulaGuard(`'${NEL}=SUM(A1)`), `${NEL}=SUM(A1)`)
assert.equal(stripFormulaGuard(`'${C1A}${C1Z}@x`), `${C1A}${C1Z}@x`)
assert.equal(stripFormulaGuard(`'${NEL}abc`), `'${NEL}abc`)
assert.equal(stripFormulaGuard(`'${NEL}`), `'${NEL}`)
assert.equal(stripFormulaGuard(`'a${NEL}=1`), `'a${NEL}=1`)
assert.equal(stripFormulaGuard("'=1+1"), '=1+1')
assert.equal(stripFormulaGuard("'"), "'")
assert.equal(stripFormulaGuard("''=x"), "'=x")
assert.equal(stripFormulaGuard(`''${NEL}=x`), `'${NEL}=x`)
assert.equal(stripFormulaGuard("''"), "''")
assert.equal(stripFormulaGuard("''abc"), "''abc")

// Export then import: byte for byte, for every kind of value above and the garbled ones.
const values: string[] = [
  `${NEL}=SUM(A1)`, `${C1A}${C1Z}${NEL}+1`, `${NEL}-5`, `${NEL}-x`, `${NEL}@me`, `${NEL}\tx`, `${NEL}abc`,
  'C1test\u0080\u0089end', 'FraudFighterâ\u0084¢', 'CODE Ã\u0089xitos', '=1+1', '-5', 'plain', `${NEL}`,
  "'=x", "'-5", "''=x", `'${NEL}=x`, `'${C1A}${NEL}@me`, "'abc", "'", `'${NEL}`,
]
// And every value of 1 to 4 characters made of a quote, C1, triggers, a digit and a letter.
const ALPHABET = ["'", NEL, C1A, '=', '-', '@', '\t', '5', 'a']
let short = ['']
for (let n = 1; n <= 4; n++) {
  short = short.flatMap(s => ALPHABET.map(c => s + c))
  values.push(...short)
}
const csv = ['val', ...values.map(escapeCsvCell)].join('\r\n')
const back: string[] = []
for await (const row of (await scanCsvText(csv)).rows()) back.push(String(row.val))
assert.deepEqual(back, values)

console.log('csv-guard-c1: all assertions passed')

// CSV export guards formulas without changing numbers, import undoes the guard,
// and semicolon/tab files are read with the right separator, so an export
// re-imports to the same values.
import assert from 'node:assert/strict'
import safetyMod from '../../server/src/lib/csv-safety'
import parseMod from '../../server/src/lib/csv-import-parse'
const { escapeCsvCell, stripFormulaGuard } = safetyMod as typeof import('../../server/src/lib/csv-safety')
const { sniffSeparator, scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

// Export: formulas are guarded, plain numbers aren't.
assert.equal(escapeCsvCell('=1+1'), `"'=1+1"`)
assert.equal(escapeCsvCell('@SUM(A1)'), `"'@SUM(A1)"`)
assert.equal(escapeCsvCell('-1+1'), `"'-1+1"`)
assert.equal(escapeCsvCell('+44 20 7946 0958'), `"'+44 20 7946 0958"`)
for (const n of ['-5', '+44', '-3.14', '-.5', '1e5', '-2E-3']) assert.equal(escapeCsvCell(n), `"${n}"`, n)

// Import: the guard comes off, other leading quotes stay.
assert.equal(stripFormulaGuard("'=1+1"), '=1+1')
assert.equal(stripFormulaGuard("'+44 20"), '+44 20')
assert.equal(stripFormulaGuard("'abc"), "'abc")
assert.equal(stripFormulaGuard("'"), "'")
assert.equal(stripFormulaGuard(42), 42)

// Separator from the header line.
assert.equal(sniffSeparator('name;city;amount\nAnna;Berlin;1,50'), ';')
assert.equal(sniffSeparator('\uFEFFname;city\n'), ';')
assert.equal(sniffSeparator('a,b,c\n1;2,3'), ',')
assert.equal(sniffSeparator('"a;b;c",d\n'), ',')
assert.equal(sniffSeparator('a\tb\tc'), '\t')
assert.equal(sniffSeparator('only'), ',')

;(async () => {
  const semi = await scanCsvText('name;city;amount\nAnna;Berlin;1,50\n')
  assert.deepEqual(semi.summary.headers, ['name', 'city', 'amount'])
  const [row] = [...await collect(semi.rows())]
  assert.deepEqual(row, { name: 'Anna', city: 'Berlin', amount: '1,50' })

  // Round trip: export the values, import the file, get the same values back.
  const values = ['-5', '+44 20 7946 0958', '=1+1', '@x', "'quoted", 'plain', '3.14']
  const csv = 'v\n' + values.map(v => escapeCsvCell(v)).join('\n') + '\n'
  const back = (await collect((await scanCsvText(csv)).rows())).map(r => r.v)
  assert.deepEqual(back, values)
  const header = await scanCsvText(`${escapeCsvCell('=Total')},b\n1,2\n`)
  assert.deepEqual(header.summary.headers, ['=Total', 'b'])
  console.log('All csv-roundtrip assertions passed.')
})().catch(e => { console.error(e); process.exit(1) })

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const x of it) out.push(x); return out }

// CSV headers an object can't hold as plain keys (lib/csv-import-parse.ts): "__proto__", "constructor" and
// "prototype", which csv-parser drops, come through both scans (text and file) as columns of their own name with
// their cells as own keys of each row; other Object.prototype names ("toString") are unchanged; and a header that
// sanitizes to one of them still collides with it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import parseMod from '../../server/src/lib/csv-import-parse'
const { scanCsvFile, scanCsvText, CsvHeaderCollisionError } =
  parseMod as typeof import('../../server/src/lib/csv-import-parse')

const NAMES = ['__proto__', 'constructor', 'prototype', 'toString']
const CSV = `Name,${NAMES.join(',')}\nAda,p,c,t,s\nBo,p2,c2,t2,s2\n`
const rowsOf = async (scan: Awaited<ReturnType<typeof scanCsvText>>) => {
  const out: Array<Record<string, unknown>> = []
  for await (const r of scan.rows()) out.push(r)
  return out
}
const cells = (r: Record<string, unknown>) => ['Name', ...NAMES].map(k => (Object.hasOwn(r, k) ? r[k] : 'MISSING'))

for (const [label, scan] of [
  ['text', () => scanCsvText(CSV)],
  ['file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cubex-keys-')), 'keys.csv')
    fs.writeFileSync(file, CSV)
    return scanCsvFile(file)
  }],
] as Array<[string, () => ReturnType<typeof scanCsvText>]>) {
  const s = await scan()
  assert.deepEqual(s.summary.headers, ['Name', ...NAMES], label)
  assert.equal(s.summary.rowCount, 2, label)
  const rows = await rowsOf(s)
  assert.deepEqual(rows.map(cells), [['Ada', 'p', 'c', 't', 's'], ['Bo', 'p2', 'c2', 't2', 's2']], label)
  assert.equal(Object.getPrototypeOf(rows[0]), null, `${label}: rows are null-prototype`)
  console.log('ok  ', `${label}: the three names are columns of their own, with their cells`)
}

await assert.rejects(scanCsvText('__proto__,"__proto__ "\nx,y\n'), CsvHeaderCollisionError)
console.log('ok   a header that sanitizes to "__proto__" collides with it')
console.log('csv-object-key-headers: all assertions passed')

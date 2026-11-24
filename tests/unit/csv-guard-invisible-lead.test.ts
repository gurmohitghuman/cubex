// The CSV export's formula guard (lib/csv-safety.ts) looks at a value's first VISIBLE character: past a byte order
// mark, a no-break space, a zero-width space or joiner, a word joiner or a space (as past C1 characters), a
// formula trigger (= + - @, or their full-width forms) is quoted; a plain number or text after them isn't; and
// export then import gives every value back exactly.
import assert from 'node:assert/strict'
import safetyMod from '../../server/src/lib/csv-safety'
import parseMod from '../../server/src/lib/csv-import-parse'
const { escapeCsvCell } = safetyMod as typeof import('../../server/src/lib/csv-safety')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')

const LEADS = ['﻿', ' ', '​', '‌', '‍', '⁠', ' ', '  ', ' ​', '\u0085 ']
const TRIGGERS = ['=', '+', '-', '@', '＝', '＋', '－', '＠']
const guarded = (v: string) => escapeCsvCell(v).startsWith(`"'`)

for (const lead of LEADS) for (const t of TRIGGERS) {
  const v = `${lead}${t}HYPERLINK("http://x","y")`
  assert.ok(guarded(v), JSON.stringify(v))
}
console.log('ok   a trigger after a BOM, no-break space, zero-width space or joiner, word joiner or space is quoted')
for (const t of ['＝1+1', '＠SUM(A1)']) assert.ok(guarded(t), t)
console.log('ok   full-width = and @ at the start are quoted too')
for (const v of [' -5', ' +44', '﻿3.14', ' hello', ' Café', 'a =b', '​']) {
  assert.ok(!guarded(v), JSON.stringify(v))
}
console.log('ok   a plain number or text after them, a trigger later on, and a lead alone are left as they are')

const values = LEADS.flatMap(lead => [...TRIGGERS.map(t => `${lead}${t}1+1`), `${lead}x`, `${lead}-5`])
  .concat(["'=already", "' =x", 'plain'])
const csv = `v\n${values.map(escapeCsvCell).join('\n')}\n`
const back: string[] = []
for await (const row of (await scanCsvText(csv)).rows()) back.push(String(row.v))
assert.deepEqual(back.map(v => JSON.stringify(v)), values.map(v => JSON.stringify(v)))
console.log(`ok   export then import gives all ${values.length} values back exactly`)
console.log('csv-guard-invisible-lead: all assertions passed')

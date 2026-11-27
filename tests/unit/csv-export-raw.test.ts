// A CSV export for another tool (raw) writes every cell exactly as it is: no formula guard, only RFC-4180 quoting.
// The default export still guards (a cell a spreadsheet app would run as a formula gets a leading quote). Both
// builders: buildSheetCsv (read_rows format csv) and writeSheetCsv (downloads), through planSheetExport's raw.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import exportMod from '../../server/src/lib/csv-export'
import writeMod from '../../server/src/lib/csv-write'
import safetyMod from '../../server/src/lib/csv-safety'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { buildSheetCsv, planSheetExport } = exportMod as typeof import('../../server/src/lib/csv-export')
const { writeSheetCsv } = writeMod as typeof import('../../server/src/lib/csv-write')
const { escapeCsvCell, escapeCsvCellRaw } = safetyMod as typeof import('../../server/src/lib/csv-safety')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

// The cell: quoting only, the value whole.
assert.equal(escapeCsvCellRaw('+1-415-555-0199'), '"+1-415-555-0199"')
assert.equal(escapeCsvCellRaw('say "hi", then go'), '"say ""hi"", then go"')
assert.equal(escapeCsvCellRaw(null), '""')
assert.equal(escapeCsvCell('+1-415-555-0199'), `"'+1-415-555-0199"`, 'the default still guards')
console.log('ok   a raw cell is only quoted; the default still adds the guard')

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const COLUMNS = ['Phone', 'Handle', 'Note', '=Header']
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(COLUMNS))
const ROWS = [
  { Phone: '+1 (415) 555-0199', Handle: '@johndoe', Note: '- Hiring 3 SDRs', '=Header': '-15%' },
  { Phone: '+44 20 7946 0958', Handle: '@jane', Note: '=HYPERLINK("x")', '=Header': 'a, "b"' },
]
ROWS.forEach((data, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, i, JSON.stringify(data)))

const rawLine = (values: string[]) => values.map(escapeCsvCellRaw).join(',')
const expected = [rawLine(COLUMNS), ...ROWS.map(r => rawLine(COLUMNS.map(c => r[c as keyof typeof r])))].join('\r\n')

const built = await buildSheetCsv(sid, uid, { raw: true })
assert.ok('csv' in built)
assert.equal((built as { csv: string }).csv, expected)
const guarded = await buildSheetCsv(sid, uid)
assert.ok('csv' in guarded && (guarded as { csv: string }).csv.includes(`"'+1 (415) 555-0199"`))
assert.ok((guarded as { csv: string }).csv.startsWith(`"Phone","Handle","Note","'=Header"`))
console.log('ok   read_rows\' builder: raw writes every cell and header as it is; without raw they are guarded')

const where = [{ column: 'Handle', operator: 'contains' as const, value: 'jane' }]
const plan = planSheetExport(sid, uid, { raw: true, where })
assert.ok(!('fail' in plan) && plan.raw === true && plan.filter, 'the plan keeps raw, with a filter too')
let streamed = ''
const ready = plan as Exclude<typeof plan, { fail: unknown }>
await writeSheetCsv(sid, uid, ready, async c => { streamed += c; return true })
const jane = COLUMNS.map(c => ROWS[1][c as keyof typeof ROWS[1]])
assert.equal(streamed, [rawLine(COLUMNS), rawLine(jane)].join('\r\n'))
const plain = planSheetExport(sid, uid, {})
assert.ok(!('fail' in plain) && plain.raw === undefined, 'no raw unless asked')
console.log('ok   downloads (writeSheetCsv): raw through the plan, filtered rows as they are')

console.log('csv-export-raw: all assertions passed')

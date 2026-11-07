// Adding a field a webhook fills, through the real route (POST
// /api/sheets/:id/webhook/mappings, services/webhook-mapping-add.ts): the new
// column is only listed in column_order. No row is written (data and updated_at
// stay, a trigger counts 0 row writes), an empty sheet stays empty (its first
// event is row 0), a busy sheet is refused with 409 busy before anything is
// checked or read, and the path, name, collision, cap and 404 answers are the
// same; a json value mode is stored. Then a delivery fills the column on its
// new row while the older rows read it as empty: the empty/not_empty filters,
// get_sheet's counts and CSV lines.
import express from 'express'
import cookieParser from 'cookie-parser'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import authMod from '../../server/src/lib/auth'
import whMod from '../../server/src/lib/webhook-service'
import ingestMod from '../../server/src/lib/webhook-ingest'
import busyMod from '../../server/src/lib/sheet-busy'
import sqlMod from '../../server/src/lib/row-filter/sql'
import countsMod from '../../server/src/services/column-counts'
import csvMod from '../../server/src/lib/csv-write'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { signToken } = authMod as typeof import('../../server/src/lib/auth')
const { createSourceWithColumn } = whMod as typeof import('../../server/src/lib/webhook-service')
const { appendWebhookDelivery } = ingestMod as typeof import('../../server/src/lib/webhook-ingest')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { compileWhere } = sqlMod as typeof import('../../server/src/lib/row-filter/sql')
const { columnCounts } = countsMod as typeof import('../../server/src/services/column-counts')
const { csvLine } = csvMod as typeof import('../../server/src/lib/csv-write')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
function sheet(name: string, columns: string[], rows: number): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
    .run(sid, tid, uid, name, JSON.stringify(columns))
  for (let i = 0; i < rows; i++) {
    db.prepare(`INSERT INTO rows (id, sheet_id, user_id, row_index, data, updated_at)
      VALUES (?, ?, ?, ?, ?, '2020-01-01 00:00:00')`).run(uuid(), sid, uid, i, JSON.stringify({ Name: `n${i}` }))
  }
  createSourceWithColumn(sid, uid, name)
  return sid
}
const leads = sheet('Leads', ['Name', 'Email'], 3)
const empty = sheet('Empty', [], 0)

// Every write to rows, counted by a trigger on this connection.
db.exec(`CREATE TEMP TABLE row_writes (n INTEGER NOT NULL);
  CREATE TEMP TRIGGER count_row_updates AFTER UPDATE ON main.rows BEGIN INSERT INTO row_writes VALUES (1); END;
  CREATE TEMP TRIGGER count_row_inserts AFTER INSERT ON main.rows BEGIN INSERT INTO row_writes VALUES (1); END;`)
const rowWrites = () => db.prepare('SELECT count(*) FROM temp.row_writes').pluck().get() as number
const snapshot = (sid: string) => db.prepare('SELECT id, data, updated_at FROM rows WHERE sheet_id = ? ORDER BY rowid')
  .all(sid) as Array<{ id: string; data: string; updated_at: string }>
const listed = (sid: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?')
  .pluck().get(sid) as string) as string[]

const webhookRoutes = (await import('../../server/src/routes/sheets-webhooks')).default
const app = express()
app.use(cookieParser())
app.use(express.json())
app.use('/api/sheets', webhookRoutes)
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
async function addMapping(sid: string, jsonPath: string, columnName: string, valueMode?: string) {
  const res = await fetch(`${base}/api/sheets/${sid}/webhook/mappings`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ jsonPath, columnName, valueMode }),
  })
  return { status: res.status, body: await res.json() as Record<string, any> }
}

// Adding a mapping on a sheet with rows writes no row.
const before = snapshot(leads)
const writesBefore = rowWrites()
const added = await addMapping(leads, '$.mail', 'Mail')
const after = snapshot(leads)
const changed = after.filter((r, i) => r.data !== before[i]?.data || r.updated_at !== before[i]?.updated_at).length
check('a mapping is added (201, listed with its path)', added.status === 201
  && added.body.mappings.some((m: any) => m.columnName === 'Mail' && m.jsonPath === '$.mail'), added)
check('no row is written (0 row writes, 0 rows changed, the same rows)', rowWrites() === writesBefore
  && changed === 0 && after.length === before.length, { writes: rowWrites() - writesBefore, changed, after })
check('the column is listed last', listed(leads).at(-1) === 'Mail', listed(leads))
check('the History says so', db.prepare('SELECT summary FROM sheet_changes WHERE sheet_id = ? ORDER BY id DESC')
  .pluck().get(leads) === 'The webhook fills "Mail" from $.mail')

// An empty sheet stays empty: its first event is row 0.
const writesEmpty = rowWrites()
check('a mapping on an empty sheet adds no row', (await addMapping(empty, '$.a', 'A')).status === 201
  && snapshot(empty).length === 0 && rowWrites() === writesEmpty && listed(empty).includes('A'))
const source = (sid: string) => db.prepare('SELECT * FROM webhook_sources WHERE sheet_id = ?').get(sid) as
  Parameters<typeof appendWebhookDelivery>[0]
const mappings = (sid: string) => db.prepare(`SELECT json_path, column_name, value_mode FROM webhook_mappings
  WHERE source_id = ?`).all(source(sid).id) as Parameters<typeof appendWebhookDelivery>[1]
const deliver = (sid: string, body: Record<string, unknown>) =>
  appendWebhookDelivery(source(sid), mappings(sid), body, JSON.stringify(body))
const firstEvent = deliver(empty, { a: 'first' })
check('... and its first event is row 0', firstEvent.ok && firstEvent.rowIndex === 0, firstEvent)

// The same answers as before for a bad path, a taken name and the column cap.
const badPath = await addMapping(leads, '$..mail', 'Other')
check('a path with recursion is refused (400)', badPath.status === 400 && /simple field path/.test(badPath.body.error))
const taken = await addMapping(leads, '$.name', 'name')
check('a name another column has (any case) is refused (400)', taken.status === 400
  && taken.body.error === 'A column named "Name" already exists (names are case-insensitive). '
    + 'Choose a different name.', taken)
const full = sheet('Full', Array.from({ length: 199 }, (_, i) => `C${i}`), 0)
const capped = await addMapping(full, '$.x', 'X')
check('a sheet at the column cap is refused (400)', capped.status === 400
  && capped.body.error === 'Column limit reached (200 per sheet).', capped)
const noName = await addMapping(leads, '$.n', '')
check('an empty name becomes "Column", as before (201)', noName.status === 201
  && mappings(leads).some(m => m.column_name === 'Column' && m.json_path === '$.n'), noName)
const symbols = await addMapping(leads, '$.s', '!!!')
check('a name without a letter or digit is refused (400)', symbols.status === 400
  && /needs at least one letter A-Z or digit 0-9/.test(symbols.body.error), symbols)
const reserved = await addMapping(leads, '$.r', '__rowIndex')
check('the reserved __rowIndex is refused (400)', reserved.status === 400
  && reserved.body.error === '"__rowIndex" is reserved for Cubex\'s internal row identity. Choose a different name.',
  reserved)
const noSheet = await addMapping(uuid(), '$.x', 'X')
check('an unknown sheet answers 404', noSheet.status === 404 && noSheet.body.error === 'Sheet not found', noSheet)
const bare = uuid()
db.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?, ?, ?, ?)').run(bare, tid, uid, 'Bare')
const noHook = await addMapping(bare, '$.x', 'X')
check('a sheet without a webhook answers 404', noHook.status === 404
  && noHook.body.error === 'No webhook on this sheet.', noHook)
const asJson = await addMapping(leads, '$.payload', 'Payload', 'json')
check('a json value mode is stored', asJson.status === 201 && mappings(leads)
  .some(m => m.column_name === 'Payload' && m.value_mode === 'json'), mappings(leads))

// A busy sheet (a sort, an import, a column rename) is refused, and nothing changes.
let release = () => {}
const held = withSheetBusy(leads, 'sorting', () => new Promise<void>(r => { release = r }))
const busy = await addMapping(leads, '$.busy', 'Busy')
release()
await held
check('a busy sheet answers 409 busy', busy.status === 409 && busy.body.busy === true
  && /This sheet is busy sorting/.test(busy.body.error), busy)
check('... and adds no column or mapping', !listed(leads).includes('Busy')
  && mappings(leads).every(m => m.column_name !== 'Busy'))
// The busy check comes first: before the request is checked (409, not 400) and
// before the columns are read, which on a sheet from before the column list writes them.
const old = sheet('Old', ['Name'], 2)
db.prepare('UPDATE sheets SET column_order = NULL WHERE id = ?').run(old)
let releaseOld = () => {}
const heldOld = withSheetBusy(old, 'sorting', () => new Promise<void>(r => { releaseOld = r }))
const busyBad = await addMapping(old, '$..bad', 'Bad')
const busyGood = await addMapping(old, '$.good', 'Good')
releaseOld()
await heldOld
check('a busy sheet answers 409 busy to a request it would refuse anyway', busyBad.status === 409
  && busyBad.body.busy === true, busyBad)
check('... and writes no column list while busy', busyGood.status === 409
  && db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(old) === null)

// A delivery fills the new column on its row; the older rows read it as empty.
const delivered = deliver(leads, { mail: 'a@x.com' })
const rows = db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(leads) as string[]
const cells = rows.map(d => JSON.parse(d) as Record<string, string>)
check('the delivery fills the column on its new row', delivered.ok && cells.at(-1)?.Mail === 'a@x.com', cells)
check('the older rows have no key for it', cells.slice(0, 3).every(c => !('Mail' in c)), cells)
const matching = (operator: 'empty' | 'not_empty') => {
  const f = compileWhere([{ column: 'Mail', operator }], new Map())
  return db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND (${f.sql})`).pluck().get(leads, ...f.params)
}
check('the empty filter finds the 3 older rows, not_empty the new one', matching('empty') === 3
  && matching('not_empty') === 1, [matching('empty'), matching('not_empty')])
const counts = await columnCounts(leads, uid, ['Mail'], new Map())
const mail = 'ok' in counts ? counts.ok.get('Mail') : null
check("get_sheet's counts: 1 filled, 3 empty", mail?.filled === 1 && mail?.empty === 3 && mail?.errors === 0, mail)
const columns = listed(leads)
check('CSV lines write the older rows the same as with an empty cell there', cells.slice(0, 3)
  .every(c => csvLine(columns, c) === csvLine(columns, { ...c, Mail: '' })), cells.map(c => csvLine(columns, c)))
const named = ['constructor', 'toString']
check('... also for a column named like an object member (not the inherited function)',
  csvLine(named, JSON.parse('{}')) === csvLine(named, { constructor: '', toString: '' }), csvLine(named, {}))

server.close()
console.log(failures === 0 ? '\nwebhook mapping add: all passed' : `\nwebhook mapping add: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

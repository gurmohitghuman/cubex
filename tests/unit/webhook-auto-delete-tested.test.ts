// Auto-delete's copy and a test of column changes (services/sheet-test-*.ts) on a throwaway database: rows are
// never copied into a test's hidden copy (deleted when its test ends, so they would be lost) nor into a sheet whose
// changes are being tested (it takes no change until then). Setting auto-delete refuses either as the copy's sheet,
// in the one service the app, REST and MCP call; a destination kept from before waits out a test begun since, and
// the answer's waiting says why. The move step checks again in each slice that copies: one saved before the check
// that names a test copy pauses with the reason, copying and deleting nothing, and copyRows itself copies nothing
// into either.
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { createSourceWithColumn } = await import('../../server/src/lib/webhook-service')
const { getSheetWebhook, setSheetWebhookAutoDelete, sheetWebhookView } =
  await import('../../server/src/services/sheet-webhook')
const { autoDeleteSweep } = await import('../../server/src/services/webhook-auto-delete-sweep')
const { copyRows, TEST_COPY_REFUSED } = await import('../../server/src/services/webhook-auto-delete-move')
const { startSheetTest } = await import('../../server/src/services/sheet-test-start')
const { discardSheetTest } = await import('../../server/src/services/sheet-test-end')

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
let position = 0
function sheet(name: string, rows: number, extra: Record<string, string> = {}): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, position, column_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, tid, uid, name, position++, JSON.stringify(['Company', ...Object.keys(extra)]))
  const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  for (let i = 0; i < rows; i++) insert.run(uuid(), id, uid, i, JSON.stringify({ Company: `c${i}`, ...extra }))
  return id
}
const count = (sheetId: string) =>
  db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(sheetId) as number
const view = (sheetId: string) => {
  const got = getSheetWebhook(uid, sheetId)
  return 'ok' in got && got.ok ? sheetWebhookView(got.ok, null).auto_delete : undefined
}
const set = (sheetId: string, input: Record<string, unknown>) => setSheetWebhookAutoDelete(uid, sheetId, input)
const refused = (sheetId: string, input: Record<string, unknown>) => {
  const o = set(sheetId, input)
  return 'fail' in o ? o.message : null
}
let clock = Date.now()
const sweep = async () => { clock += 120_000; await autoDeleteSweep(clock) }
async function startTest(sheetId: string): Promise<string> {
  const out = await startSheetTest(uid, sheetId, { rows: 2 })
  if ('fail' in out) throw new Error(out.message)
  return out.ok.test_sheet_id
}

// The webhook sheet: 10 rows it added, the newest 2 kept, the rest finished (no auto-run).
const hooks = sheet('Hooks', 0)
const { source } = createSourceWithColumn(hooks, uid, 'Webhook')
const raw = source.raw_column_name
db.prepare(`UPDATE sheets SET column_order = ? WHERE id = ?`).run(JSON.stringify(['Company', raw]), hooks)
const insert = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
for (let i = 0; i < 10; i++) insert.run(uuid(), hooks, uid, i, JSON.stringify({ Company: `h${i}`, [raw]: '📥 12:00' }))

const leads = sheet('Leads', 3)
const leadsCopy = await startTest(leads)

check('a test copy is refused as the sheet rows are copied to, in words',
  refused(hooks, { keep_rows: 2, copy_to_sheet_id: leadsCopy }) === TEST_COPY_REFUSED, view(hooks))
check('a sheet being tested is refused as a new destination, in words',
  /^Rows can't be copied into "Leads" while changes are tested on it\. Apply or discard/
    .test(refused(hooks, { keep_rows: 2, copy_to_sheet_id: leads }) ?? ''), view(hooks))
check('neither turned auto-delete on', view(hooks) === null)

// A destination kept from before waits out a test begun since, and says why.
const archive = sheet('Archive', 3)
check('on, copying to Archive', 'ok' in set(hooks, { keep_rows: 2, copy_to_sheet_id: archive }))
await startTest(archive)
await sweep()
check('Archive being tested: nothing copied, nothing deleted', count(archive) === 3 && count(hooks) === 10,
  { archive: count(archive), hooks: count(hooks) })
check('the answer says what rows wait for', view(hooks)?.paused === null && view(hooks)?.waiting ===
  'Changes are being tested on "Archive", where rows are copied: rows wait until that test is applied or '
  + 'discarded.', view(hooks))
check('a change that keeps the destination still saves', 'ok' in set(hooks, { keep_rows: 3 }), view(hooks))
discardSheetTest(uid, archive)
await sweep()
check('the test discarded: the older rows are copied, then deleted', count(archive) === 10 && count(hooks) === 3,
  { archive: count(archive), hooks: count(hooks) })
check('nothing waits now', view(hooks)?.waiting === null && view(hooks)?.paused === null, view(hooks))

// One saved before the check that names a test copy: the move step pauses it, copying and deleting nothing.
for (let i = 10; i < 20; i++) insert.run(uuid(), hooks, uid, i, JSON.stringify({ Company: `h${i}`, [raw]: '📥 1' }))
db.prepare('UPDATE webhook_auto_delete SET copy_to_sheet_id = ? WHERE source_id = ?').run(leadsCopy, source.id)
const before = { hooks: count(hooks), copy: count(leadsCopy) }
await sweep()
check('a test copy as the destination: nothing copied, nothing deleted',
  count(hooks) === before.hooks && count(leadsCopy) === before.copy, { before, hooks: count(hooks) })
check('it pauses with the reason, in the answer and the History', view(hooks)?.paused === TEST_COPY_REFUSED
  && (db.prepare('SELECT summary FROM sheet_changes WHERE sheet_id = ? ORDER BY id DESC LIMIT 1').pluck()
    .get(hooks) as string) === `Auto-delete paused: ${TEST_COPY_REFUSED}`, view(hooks))

// copyRows itself, in a slice's transaction: neither destination takes a row.
const rowids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY row_index LIMIT 2').pluck()
  .all(hooks) as number[]
const tryCopy = (to: string) => db.transaction(() =>
  copyRows(hooks, uid, raw, rowids, { sheetId: to, name: 'X', rows: null })).immediate()
check('copyRows into a test copy: a pause, no row', JSON.stringify(tryCopy(leadsCopy)) ===
  JSON.stringify({ pause: TEST_COPY_REFUSED }) && count(leadsCopy) === before.copy)
check('copyRows into a sheet being tested: it waits, no row', JSON.stringify(tryCopy(leads)) ===
  JSON.stringify({ wait: true }) && count(leads) === 3)

if (failures > 0) { console.error(`${failures} webhook-auto-delete-tested check(s) failed`); process.exit(1) }
console.log('webhook-auto-delete-tested: all passed')

// Over 200 lines: one test's story on one sheet, from start through apply, each check building on the one before.
// Trying column changes on sample rows (services/sheet-test-*.ts, migration 070) on a migrated throwaway DB: a test
// copies the top rows (values and what their results were made from) and the setup into a copy no list shows; the
// sheet turns read-only (changes and appends refused as busy, reads and lookups go on) and its webhook deliveries
// wait; rows can be added; a second test, a test of the copy and a test during a run are refused; a dry apply
// changes nothing; apply writes the copy's setup (the old one kept as a version), puts back the result of each
// sample row the new setup made from the same inputs (a $0 run of its own, undoable, its answer with it), works a
// changed formula out again, and ends the test: the copy goes and the kept deliveries are added in order. A
// discarded test leaves the sheet as it was; a restart holds an open test's sheet again.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}

runMigrations()
const { startSheetTest } = await import('../../server/src/services/sheet-test-start')
const { addTestRows } = await import('../../server/src/services/sheet-test-add')
const { applySheetTest } = await import('../../server/src/services/sheet-test-apply')
const { discardSheetTest, resumeSheetTests } = await import('../../server/src/services/sheet-test-end')
const { testOfSheet } = await import('../../server/src/services/sheet-test-store')
const busy = await import('../../server/src/lib/sheet-busy')
const hold = await import('../../server/src/lib/sheet-test-hold')
const { appendRows } = await import('../../server/src/services/rows-write')
const { appendWebhookDelivery } = await import('../../server/src/lib/webhook-ingest')
const { listSheets } = await import('../../server/src/lib/sheet-crud-helpers')
const { liveSheets } = await import('../../server/src/services/table-row-counts')
const { aiRunStamper } = await import('../../server/src/lib/run-inputs/stampers')
const { ensureRunInputKey } = await import('../../server/src/lib/run-inputs/keys')
const { deleteRowsToTrash } = await import('../../server/src/services/trash-rows')
const { listTrash } = await import('../../server/src/services/trash-read')

const uid = uuid(), tid = uuid(), sid = uuid()
const COLS = ['Name', 'Domain', 'Fit', 'Short']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(COLS))
const P1 = 'Is /name a fit?', P2 = 'Is /name at /domain a fit?'
const aiRun = (sheet: string, prompt: string, status = 'completed') => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,total_rows,processed_rows)
    VALUES (?,?,?,'Fit',?,'m1',?,0,0)`).run(id, sheet, uid, prompt, status)
  return id
}
const oldRun = aiRun(sid, P1)
const stamp = (sheet: string, runId: string, data: string) => aiRunStamper(
  db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(runId) as never).stamp(data)
for (let i = 0; i < 30; i++) {
  const data = JSON.stringify({ Name: `n${i}`, Domain: `d${i}.com`, Fit: 'old', Short: `n${i}`.slice(0, 2) })
  const s = stamp(sid, oldRun, data)
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data,run_inputs) VALUES (?,?,?,?,?,json_object(?,?))')
    .run(uuid(), sid, uid, i, data, s.path.slice(3, -1), s.fp)
}
db.prepare(`INSERT INTO formula_columns (id,user_id,sheet_id,column_name,formula,inputs,fill_status)
  VALUES (?,?,?,'Short','{{Name}}.slice(0, 2)','["Name"]','done')`).run(uuid(), uid, sid)
const src = uuid()
db.prepare(`INSERT INTO webhook_sources (id,user_id,sheet_id,token_hash,raw_column_name,store_raw_mode)
  VALUES (?,?,?,'h1','Webhook','none')`).run(src, uid, sid)
db.prepare(`INSERT INTO webhook_mappings (id,source_id,user_id,json_path,column_name) VALUES (?,?,?,'$.name','Name')`)
  .run(uuid(), src, uid)
const source = () => db.prepare('SELECT * FROM webhook_sources WHERE id = ?').get(src) as never
const deliver = (name: string) => appendWebhookDelivery(source(), [{ json_path: '$.name', column_name: 'Name',
  value_mode: 'scalar' }], { name }, JSON.stringify({ name }), { tokenHash: 'h1' })
const rows = (sheet: string) => db.prepare('SELECT id, row_index, data, run_inputs FROM rows WHERE sheet_id = ? '
  + 'ORDER BY row_index').all(sheet) as Array<{ id: string; row_index: number; data: string; run_inputs: string }>
const until = async (ok: () => boolean, what: string) => {
  for (const end = Date.now() + 15_000; !ok();) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

let copy = ''
await check('a run going refuses a test', async () => {
  const going = aiRun(sid, P1, 'running')
  const out = await startSheetTest(uid, sid, {})
  assert.ok('fail' in out && /run is going/.test(out.message), JSON.stringify(out))
  db.prepare('DELETE FROM ai_runs WHERE id = ?').run(going)
})

await check('start: the top 10 rows and the setup go into a copy no list shows', async () => {
  const out = await startSheetTest(uid, sid, {})
  assert.ok('ok' in out, JSON.stringify(out))
  copy = out.ok.test_sheet_id
  assert.equal(out.ok.rows, 10)
  const got = rows(copy)
  assert.deepEqual(got.map(r => JSON.parse(r.data).Name), Array.from({ length: 10 }, (_, i) => `n${i}`))
  const key = ensureRunInputKey(copy, uid, 'Fit')
  assert.ok(JSON.parse(got[0].run_inputs)[String(key)], 'the stamp moved to the copy\'s key')
  assert.deepEqual(JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(copy) as string),
    COLS)
  assert.equal((db.prepare(`SELECT prompt FROM ai_runs WHERE sheet_id = ? ORDER BY rowid DESC`).get(copy) as any)
    .prompt, P1)
  assert.deepEqual(listSheets(tid, uid).map(s => s.id), [sid])
  assert.deepEqual(liveSheets(uid).map(s => s.id), [sid])
  assert.equal(db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(copy), 'Leads')
})

await check('while testing: changes and appends are refused, reads and lookups go on', async () => {
  assert.equal(busy.sheetBusyWith(sid), hold.TESTING)
  assert.equal(busy.rowsMovingOn(sid), null)
  const appended = appendRows(sid, uid, [{ Name: 'x' }])
  assert.ok('fail' in appended && appended.fail === 'busy')
  const heavy = await busy.withSheetBusy(sid, 'sorting', async () => 'ran')
  assert.ok(typeof heavy === 'object' && 'busy' in heavy && /apply or discard/.test(heavy.busy))
  assert.equal(await busy.withSheetRead(sid, async () => 'read'), 'read')
  assert.equal(busy.sheetBusyWith(copy), null, 'the copy takes changes')
})

await check('a second test, and a test of the copy, are refused', async () => {
  const again = await startSheetTest(uid, sid, {})
  assert.ok('fail' in again && /already being tested/.test(again.message))
  const ofCopy = await startSheetTest(uid, copy, {})
  assert.ok('fail' in ofCopy && /test copy/.test(ofCopy.message))
})

await check('webhook deliveries wait, kept, while the sheet is tested', () => {
  for (const n of ['w1', 'w2']) assert.equal((deliver(n) as any).status, 'held')
  assert.equal(rows(sid).length, 30)
  assert.equal(db.prepare(`SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'held'`).pluck().get(), 2)
})

await check('add rows: from the top, at random, never past 50', () => {
  const top = addTestRows(uid, sid, { rows: 5 })
  assert.ok('ok' in top && top.ok.added === 5)
  const random = addTestRows(uid, copy, { how: 'random', rows: 5 })
  assert.ok('ok' in random && random.ok.added > 0)
  assert.equal(new Set(rows(copy).map(r => JSON.parse(r.data).Name)).size, rows(copy).length, 'no row twice')
  const many = addTestRows(uid, sid, { rows: 100 })
  assert.ok('ok' in many && many.ok.rows <= 50)
})

// The person tries one prompt on row 3, changes it and runs it on the first 3 rows (one had its Name edited there),
// then runs row 0 again with the same prompt: rows 0 and 1 keep their answers, row 3's was another prompt's.
let newRun = ''
await check('a run on the copy with a new setup', () => {
  const answer = (runId: string, r: { id: string; row_index: number; data: string }) => {
    const data = JSON.stringify({ ...JSON.parse(r.data), Fit: `new ${r.row_index}` })
    const s = stamp(copy, runId, data)
    db.prepare(`UPDATE rows SET data = ?, run_inputs = json_set(COALESCE(run_inputs, '{}'), ?, ?) WHERE id = ?`)
      .run(data, s.path, s.fp, r.id)
    db.prepare(`INSERT INTO ai_results (id,run_id,user_id,row_index,output_value,status,cost_usd)
      VALUES (?,?,?,?,?,'completed',0.01)`).run(uuid(), runId, uid, r.row_index, `new ${r.row_index}`)
  }
  answer(aiRun(copy, 'Is /name a good fit?'), rows(copy)[3])
  newRun = aiRun(copy, P2)
  const copied = rows(copy)
  copied[2].data = JSON.stringify({ ...JSON.parse(copied[2].data), Name: 'edited in the test' })
  for (const r of copied.slice(0, 3)) answer(newRun, r)
  answer(aiRun(copy, P2), rows(copy)[0])
  db.prepare(`UPDATE formula_columns SET formula = '{{Name}}.slice(0, 3)' WHERE sheet_id = ?`).run(copy)
})

await check('a dry apply says what it would do and changes nothing', async () => {
  const before = rows(sid).map(r => r.data)
  const out = await applySheetTest(uid, sid, { dryRun: true, hasSecretsScope: true })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual(out.ok.results_kept, { Fit: 2 }, 'the row edited in the test is not put back')
  assert.deepEqual(out.ok.worked_out_again, ['Short'])
  assert.deepEqual(rows(sid).map(r => r.data), before)
  assert.equal(testOfSheet(sid, uid)?.state, 'open')
  assert.equal(busy.sheetBusyWith(sid), hold.TESTING)
})

await check('apply: the new setup, two results back as an undoable $0 run, the formula again', async () => {
  const out = await applySheetTest(uid, sid, { dryRun: false, hasSecretsScope: true })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.ok(out.ok.saved_before, 'the setup before is kept as a version')
  const live = rows(sid)
  assert.deepEqual(live.slice(0, 3).map(r => JSON.parse(r.data).Fit), ['new 0', 'new 1', 'old'])
  const kept = db.prepare(`SELECT * FROM ai_runs WHERE sheet_id = ? ORDER BY rowid DESC LIMIT 1`).get(sid) as any
  assert.equal(kept.prompt, P2)
  assert.equal(kept.setup_only, 0)
  assert.equal(db.prepare('SELECT COUNT(*) FROM run_usage WHERE run_id = ?').pluck().get(kept.id), 0)
  assert.deepEqual(db.prepare('SELECT row_index, cost_usd FROM ai_results WHERE run_id = ? ORDER BY row_index')
    .all(kept.id), [{ row_index: 0, cost_usd: 0 }, { row_index: 1, cost_usd: 0 }])
  assert.equal(db.prepare('SELECT row_count FROM run_undos WHERE run_id = ?').pluck().get(kept.id), 2)
  assert.notEqual(busy.sheetBusyWith(sid), hold.TESTING)
  await until(() => !testOfSheet(sid, uid), 'the test record goes')
  await until(() => JSON.parse(rows(sid)[0].data).Short === 'n0' && rows(sid).length === 32, 'deliveries in')
  assert.equal(db.prepare('SELECT COUNT(*) FROM sheets WHERE id = ?').pluck().get(copy), 0, 'the copy is gone')
  assert.deepEqual(rows(sid).slice(30).map(r => JSON.parse(r.data).Name), ['w1', 'w2'], 'in arrival order')
  const filled = () => db.prepare(`SELECT fill_status FROM formula_columns WHERE sheet_id = ?`).pluck().get(sid)
  await until(() => filled() === 'done', 'the formula filled again')
  assert.equal(JSON.parse(rows(sid)[12].data).Short, 'n12', 'worked out again with the new formula')
})

await check('discard: the sheet is as it was and takes changes again; the copy takes none', async () => {
  const before = rows(sid).map(r => r.data)
  const out = await startSheetTest(uid, sid, { rows: 3 })
  assert.ok('ok' in out, JSON.stringify(out))
  // A row deleted in the copy isn't listed in the trash under the sheet's name, only when the copy is asked for.
  const copyId = out.ok.test_sheet_id
  db.transaction(() => deleteRowsToTrash(copyId, uid, 'grid', { ids: [rows(copyId)[0].id] })).immediate()
  assert.equal(listTrash(uid).items.length, 0)
  assert.equal(listTrash(uid, { sheetId: copyId }).items.length, 1)
  const gone = discardSheetTest(uid, sid)
  assert.ok('ok' in gone)
  const version = () => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(sid) as number
  const closing = version()
  assert.equal(busy.sheetBusyWith(sid), null)
  assert.equal(busy.sheetBusyWith(out.ok.test_sheet_id), hold.CLOSING, 'nothing new starts on the closing copy')
  await until(() => !testOfSheet(sid, uid), 'the test record goes')
  assert.equal(busy.sheetBusyWith(out.ok.test_sheet_id), null)
  assert.deepEqual(rows(sid).map(r => r.data), before)
  assert.equal(listTrash(uid, { sheetId: copyId }).items.length, 0, 'its trash went with the copy')
  assert.ok(version() > closing, 'open grids hear that the test is gone')
})

await check('a restart holds an open test\'s sheet again', async () => {
  const out = await startSheetTest(uid, sid, { rows: 2 })
  assert.ok('ok' in out)
  hold.releaseTestHold(sid)
  assert.equal(busy.sheetBusyWith(sid), null)
  resumeSheetTests()
  assert.equal(busy.sheetBusyWith(sid), hold.TESTING)
  discardSheetTest(uid, sid)
  await until(() => !testOfSheet(sid, uid), 'the test record goes')
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('All sheet-test checks passed.')
process.exitCode = 0

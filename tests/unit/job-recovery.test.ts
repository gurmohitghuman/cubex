// CSV imports and run seeding run in slices and are journaled so a restart
// can undo or finish them (lib/import-undo.ts, services/run-seed.ts,
// migration 004). Pins: an interrupted append import is removed; an
// interrupted replace leaves the file's columns and keeps rows appended above
// it; seeding marks every target row, stops at a cancel, and a run caught
// seeding by a restart is failed and cleared.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import undoMod from '../../server/src/lib/import-undo'
import busyMod from '../../server/src/lib/sheet-busy'
import writeMod from '../../server/src/services/rows-write'
import seedMod from '../../server/src/services/run-seed'
import purgeMod from '../../server/src/lib/column-purge'
import phMod from '../../server/src/lib/run-placeholders'
import orphanMod from '../../server/src/lib/orphan-runs'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { resumeImports } = undoMod as typeof import('../../server/src/lib/import-undo')
const busy = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { sheetBusyWith } = busy
const { patchRowById } = writeMod as typeof import('../../server/src/services/rows-write')
const { seedThenEnqueue } = seedMod as typeof import('../../server/src/services/run-seed')
const { copyColumnKey } = purgeMod as typeof import('../../server/src/lib/column-purge')
// A start as the services make it: answers at once, seeds in the background
// with the sheet busy, then queues. Resolves once the sheet is free again.
async function start(args: Omit<Parameters<typeof seedThenEnqueue>[0], 'kind' | 'userId'>): Promise<void> {
  await busy.withSheetBusy(args.sheetId, 'starting a run', async () => {
    seedThenEnqueue({ ...args, kind: 'ai', userId: uid })
  })
  await idle(args.sheetId)
  await new Promise(r => setImmediate(r))
}
const { clearRunPlaceholders, resumeRunCleanups } = phMod as typeof import('../../server/src/lib/run-placeholders')
const { resetOrphanedRuns } = orphanMod as typeof import('../../server/src/lib/orphan-runs')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
const PH = '⏳ Processing...'

const rg = (sid: string) => (db.prepare('SELECT row_generation FROM sheets WHERE id = ?').get(sid) as { row_generation: number }).row_generation
function plainSheet(n: number): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)').run(sid, tid, uid, `S_${sid.slice(0, 8)}`, '["a"]')
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => { for (let i = 0; i < n; i++) ins.run(uuid(), sid, uid, i, JSON.stringify({ a: `v${i}` })) })()
  return sid
}
const indexes = (sid: string) => db.prepare('SELECT row_index FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid) as number[]

await ok('import: an interrupted append is removed, earlier rows stay', async () => {
  const sid = plainSheet(10)
  db.prepare("INSERT INTO import_jobs VALUES (?, ?, 0, 10, 20, '[\"a\",\"b\"]')").run(sid, uid)
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  for (let i = 10; i < 15; i++) ins.run(uuid(), sid, uid, i, '{"b":"x"}')
  resumeImports(); assert.ok(sheetBusyWith(sid)); await idle(sid)
  assert.deepEqual(indexes(sid), [...Array(10).keys()])
  assert.equal(db.prepare('SELECT 1 FROM import_jobs WHERE sheet_id = ?').get(sid), undefined)
})

await ok('import: an interrupted replace keeps the file\'s columns and rows appended above it', async () => {
  const sid = plainSheet(10)
  const before = rg(sid)
  db.prepare("INSERT INTO import_jobs VALUES (?, ?, 1, 0, 12, '[\"x\",\"y\"]')").run(sid, uid)
  db.prepare('DELETE FROM rows WHERE sheet_id = ? AND row_index < 4').run(sid)
  db.prepare("INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,12,'{\"w\":\"hook\"}')").run(uuid(), sid, uid)
  resumeImports(); await idle(sid)
  assert.deepEqual(indexes(sid), [12])
  const s = db.prepare('SELECT column_order, row_generation FROM sheets WHERE id = ?').get(sid) as { column_order: string; row_generation: number }
  assert.equal(s.column_order, '["x","y","w"]', "the file's columns, then those of rows that arrived above it")
  assert.ok(s.row_generation > before)
})

function seedingRun(sid: string): string {
  const id = uuid()
  db.prepare("INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,placeholder_work) VALUES (?,?,?,'o','p','pending','seeding')").run(id, sid, uid)
  return id
}
const placeholders = (sid: string) => (db.prepare("SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND json_extract(data, '$.o') = ?").get(sid, PH) as { c: number }).c

await ok('seed: every row up to lastRow gets the placeholder, then the run is queued', async () => {
  const sid = plainSheet(12_000)
  const id = seedingRun(sid)
  let queued = 0
  await start({ runId: id, sheetId: sid, columns: ['o'], targets: null, lastRow: 11_999, skip: new Set([3]), enqueue: async () => { queued++ } })
  assert.equal(placeholders(sid), 11_999)
  assert.equal(queued, 1)
  assert.equal((db.prepare('SELECT placeholder_work FROM ai_runs WHERE id = ?').get(id) as { placeholder_work: string | null }).placeholder_work, null)
})

await ok('seed: a cancel mid-seed stops it, and the cancel\'s clear removes what was written', async () => {
  const sid = plainSheet(12_000)
  const id = seedingRun(sid)
  setImmediate(() => db.prepare("UPDATE ai_runs SET status = 'cancelled', placeholder_work = 'clearing' WHERE id = ?").run(id))
  let queued = 0
  await start({ runId: id, sheetId: sid, columns: ['o'], targets: null, lastRow: 11_999, enqueue: async () => { queued++ } })
  assert.equal(queued, 0)
  assert.ok(placeholders(sid) > 0 && placeholders(sid) < 12_000, 'stopped part-way')
  await clearRunPlaceholders('ai', id)
  assert.equal(placeholders(sid), 0)
})

await ok('seed: a restart mid-seed fails the run and clears its cells', async () => {
  const sid = plainSheet(100)
  const id = seedingRun(sid)
  db.prepare("UPDATE rows SET data = json_set(data, '$.o', ?) WHERE sheet_id = ? AND row_index < 40").run(PH, sid)
  resetOrphanedRuns()
  const run = db.prepare('SELECT status, placeholder_work FROM ai_runs WHERE id = ?').get(id) as { status: string; placeholder_work: string }
  assert.deepEqual(run, { status: 'failed', placeholder_work: 'clearing' })
  resumeRunCleanups()
  while ((db.prepare('SELECT placeholder_work FROM ai_runs WHERE id = ?').get(id) as { placeholder_work: string | null }).placeholder_work) {
    await new Promise(r => setTimeout(r, 5))
  }
  assert.equal(placeholders(sid), 0)
})

await ok('busy: a job that fails half-way keeps the sheet busy until its retry succeeds', async () => {
  const sid = plainSheet(1)
  let retried = 0
  const out = await busy.withSheetBusy(sid, 'testing', async reserve => {
    reserve(500)
    busy.stayBusyToFinish(sid, 'finishing the test', async () => { retried++ })
    return 'failed'
  })
  assert.equal(out, 'failed')
  assert.equal(busy.sheetBusyWith(sid), 'finishing the test')
  assert.equal(busy.nextRowIndex(sid, uid), 500, 'the reserved range is kept')
  await idle(sid)
  assert.equal(retried, 1)
})

await ok('busy: a row patched by id waits out a heavy operation', async () => {
  const sid = plainSheet(1)
  const rowId = db.prepare('SELECT id FROM rows WHERE sheet_id = ?').pluck().get(sid) as string
  let result: unknown
  await busy.withSheetBusy(sid, 'sorting', async () => { result = patchRowById(rowId, uid, { a: 'x' }) })
  assert.deepEqual(result, { fail: 'busy', message: busy.busyMessage('sorting') })
  assert.ok('ok' in patchRowById(rowId, uid, { a: 'x' }))
})

await ok('rename: a row appended while the copy runs is copied too', async () => {
  const sid = plainSheet(12_000)
  db.prepare("UPDATE rows SET row_index = -1 - row_index WHERE sheet_id = ?").run(sid) // storage order ≠ row order
  setImmediate(() => db.prepare("INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,30000,'{\"a\":\"late\"}')").run(uuid(), sid, uid))
  await copyColumnKey(sid, uid, 'a', 'b')
  const missing = db.prepare("SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND json_extract(data, '$.a') IS NOT json_extract(data, '$.b')").get(sid) as { c: number }
  assert.equal(missing.c, 0)
  assert.equal(db.prepare("SELECT json_extract(data, '$.b') FROM rows WHERE sheet_id = ? AND row_index = 30000").pluck().get(sid), 'late')
})

if (failures > 0) { console.error(`${failures} job-recovery assertion(s) failed`); process.exit(1) }
console.log('All job-recovery assertions passed.')

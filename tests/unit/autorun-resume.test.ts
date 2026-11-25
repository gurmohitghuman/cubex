// Resuming auto-run paused by hand (services/autorun-resume.ts), on a migrated throwaway DB: waiting_rows run
// keeps every waiting row (as before), empty_only drops those whose cell holds a value, skip drops them all and
// moves the watermark to the top row; one column's resume touches only its own rows, a clean column's are never
// dropped, History says which, and set_auto_run refuses a bad waiting_rows or one with paused true. Slices of
// HEAVY_SLICE_ROWS: 12,000 waiting rows go in more than one.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import resumeMod from '../../server/src/services/autorun-resume'
import settingsMod from '../../server/src/services/autorun-settings'
import agentMod from '../../server/src/services/enrich-agent-autorun'
import constMod from '../../server/src/lib/constants'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { resumeAutorun } = resumeMod as typeof import('../../server/src/services/autorun-resume')
const { setSheetAutorunPaused } = settingsMod as typeof import('../../server/src/services/autorun-settings')
const { agentSetAutorun } = agentMod as typeof import('../../server/src/services/enrich-agent-autorun')
const { HEAVY_SLICE_ROWS } = constMod as typeof import('../../server/src/lib/constants')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')

// A sheet of `rows` rows, with two HTTP API auto-runs (Status, Other) and a clean column's, all paused by hand
// with every row waiting; Status holds a value on every third row. Rows 0-9 were there when it was paused.
function sheet(rows: number) {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(sid, tid, uid, `S-${sid.slice(0, 6)}`, JSON.stringify(['Name', 'Status', 'Other', 'Clean']))
  const ids: string[] = []
  const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const id = uuid()
      ids.push(id)
      insert.run(id, sid, uid, i, JSON.stringify({ Name: `N${i}`, ...(i % 3 === 0 ? { Status: '✅ Success' } : {}) }))
    }
  }).immediate()
  const entries: Record<string, string> = {}
  for (const [column, kind] of [['Status', 'http'], ['Other', 'http'], ['Clean', 'clean']]) {
    const id = uuid()
    entries[column] = id
    db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,watermark_row_index,
      paused_reason) VALUES (?,?,?,?,?,'["Name"]',9,'user')`).run(id, uid, sid, column, kind)
    const pend = db.prepare('INSERT INTO autorun_pending (autorun_id,user_id,row_id) VALUES (?,?,?)')
    db.transaction(() => { for (const r of ids) pend.run(id, uid, r) }).immediate()
  }
  return { sid, ids, entries }
}
const waiting = (entry: string) =>
  db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?').pluck().get(entry) as number
const fence = (entry: string) =>
  db.prepare('SELECT watermark_row_index FROM autorun_columns WHERE id = ?').pluck().get(entry) as number
const pausedOf = (entry: string) =>
  db.prepare('SELECT paused_reason FROM autorun_columns WHERE id = ?').pluck().get(entry) as string | null
const lastHistory = (sid: string) => db.prepare(`SELECT summary FROM sheet_changes WHERE sheet_id = ?
  ORDER BY id DESC LIMIT 1`).pluck().get(sid) as string

async function main() {
  await ok('run: every waiting row kept, as before', async () => {
    const s = sheet(30)
    assert.equal(await resumeAutorun(uid, s.sid, 'run'), true)
    assert.deepEqual([waiting(s.entries.Status), waiting(s.entries.Other), fence(s.entries.Status)], [30, 30, 9])
    assert.equal(pausedOf(s.entries.Status), null)
    assert.equal(lastHistory(s.sid), 'Resumed auto-run of every column')
  })

  await ok('empty_only: the rows whose cell holds a value dropped, the rest kept; a clean column untouched',
    async () => {
      const s = sheet(30)
      await resumeAutorun(uid, s.sid, 'empty_only')
      assert.equal(waiting(s.entries.Status), 20, 'rows 0, 3, 6 … hold a Status')
      assert.equal(waiting(s.entries.Other), 30, 'Other is empty on every row')
      assert.equal(waiting(s.entries.Clean), 30)
      assert.equal(pausedOf(s.entries.Status), null)
      assert.equal(lastHistory(s.sid),
        'Resumed auto-run of every column, running only the waiting rows with an empty cell')
    })

  await ok('skip: every waiting row dropped and the watermark at the top row; one column\'s alone', async () => {
    const s = sheet(30)
    await resumeAutorun(uid, s.sid, 'skip', 'Other')
    assert.deepEqual([waiting(s.entries.Other), fence(s.entries.Other)], [0, 29])
    assert.deepEqual([waiting(s.entries.Status), fence(s.entries.Status), pausedOf(s.entries.Status)],
      [30, 9, 'user'], 'Status stays paused, its rows waiting')
    assert.equal(pausedOf(s.entries.Other), null)
    assert.equal(lastHistory(s.sid), 'Resumed auto-run of "Other", without running the rows that waited')
  })

  await ok(`more waiting rows than a slice (${HEAVY_SLICE_ROWS}): every one looked at`, async () => {
    const n = HEAVY_SLICE_ROWS * 2 + 1_000
    const s = sheet(n)
    await resumeAutorun(uid, s.sid, 'empty_only', 'Status')
    assert.equal(waiting(s.entries.Status), n - Math.ceil(n / 3))
    setSheetAutorunPaused(uid, s.sid, true, 'Status')
    await resumeAutorun(uid, s.sid, 'skip', 'Status')
    assert.deepEqual([waiting(s.entries.Status), fence(s.entries.Status)], [0, n - 1])
  })

  await ok('set_auto_run: waiting_rows on a resume; refused when it isn\'t one of three, or with paused true',
    async () => {
      const s = sheet(12)
      const bad = await agentSetAutorun(uid, s.sid, { paused: false, waiting_rows: 'later' }, false)
      assert.deepEqual(bad, { fail: 'bad_request', message: 'waiting_rows must be run, empty_only or skip.' })
      const both = await agentSetAutorun(uid, s.sid, { paused: true, waiting_rows: 'skip' }, false)
      assert.deepEqual(both, { fail: 'bad_request', message: 'waiting_rows goes with paused false (a resume).' })
      assert.equal(waiting(s.entries.Status), 12, 'nothing dropped by a refusal')
      const out = await agentSetAutorun(uid, s.sid, { paused: false, waiting_rows: 'skip' }, false)
      assert.ok('ok' in out, JSON.stringify(out))
      assert.deepEqual([waiting(s.entries.Status), waiting(s.entries.Other), waiting(s.entries.Clean)], [0, 0, 12])
    })

  assert.equal(await resumeAutorun(uid, uuid(), 'skip'), false, 'no such sheet')
  if (failures > 0) { console.error(`${failures} autorun-resume check(s) failed`); process.exit(1) }
  console.log('autorun-resume: all assertions passed')
}
void main()

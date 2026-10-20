// The stalled-run sweep (services/stalled-runs.ts) on a migrated throwaway DB,
// with the queue stood in for: a running AI or plain HTTP API run whose beat is
// older than RUN_STALL_MS is queued again with a new generation, one that beat
// lately or an enrichment run is left alone, a sweep that wakes from sleep
// does nothing, a run queued again too often or one the queue refuses is
// paused for a person.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import sweepMod from '../../server/src/services/stalled-runs'
import constantsMod from '../../server/src/lib/constants'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { requeueStalledRuns } = sweepMod as typeof import('../../server/src/services/stalled-runs')
const { RUN_STALL_SWEEP_MS, RUN_STALL_REQUEUE_MAX } = constantsMod as typeof import('../../server/src/lib/constants')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
console.error = () => {}
let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'S', '[]')

const aiRun = (minutesAgo: number) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, updated_at)
    VALUES (?,?,?,'O','p','m','running', datetime('now', ?))`).run(id, sid, uid, `-${minutesAgo} minutes`)
  return id
}
const httpRun = (minutesAgo: number, config: Record<string, unknown>) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name, updated_at)
    VALUES (?,?,?,?,'running',0,'S', datetime('now', ?))`)
    .run(id, sid, uid, JSON.stringify(config), `-${minutesAgo} minutes`)
  return id
}
const state = (table: string, id: string) => db.prepare(`SELECT status, worker_generation AS gen, pause_reason
  FROM ${table} WHERE id = ?`).get(id) as { status: string; gen: number; pause_reason: string | null }
const stale = (table: string, id: string) => db.prepare(`UPDATE ${table} SET status = 'running',
  updated_at = datetime('now', '-10 minutes') WHERE id = ?`).run(id)

let now = Date.now()
const queued: string[] = []
const sweep = (enqueue = async (_k: 'ai' | 'http', id: string) => { queued.push(id) }) => {
  now += RUN_STALL_SWEEP_MS
  return requeueStalledRuns(now, enqueue)
}

const lost = aiRun(10), fresh = aiRun(1)
const plain = httpRun(10, { requestConfig: {}, responseMapping: [] })
const enrich = httpRun(10, { enrichment: { v: 1 } })

await ok('a run whose beat is old is queued again with a new generation; others are left alone', async () => {
  await sweep()
  assert.deepEqual(state('ai_runs', lost), { status: 'pending', gen: 1, pause_reason: null })
  assert.equal(state('ai_runs', fresh).status, 'running')
  assert.deepEqual(state('http_runs', plain), { status: 'pending', gen: 1, pause_reason: null })
  assert.equal(state('http_runs', enrich).status, 'running', 'an enrichment run is left to boot')
  assert.deepEqual(queued.sort(), [lost, plain].sort())
})

await ok('a sweep that wakes from sleep does nothing', async () => {
  stale('ai_runs', lost)
  now += 10 * RUN_STALL_SWEEP_MS
  await requeueStalledRuns(now, async () => { throw new Error('not called') })
  assert.equal(state('ai_runs', lost).status, 'running')
})

await ok('queued again too often, it is paused for a person', async () => {
  for (let i = 2; i <= RUN_STALL_REQUEUE_MAX; i++) {
    stale('ai_runs', lost)
    await sweep()
    assert.equal(state('ai_runs', lost).status, 'pending', `time ${i}`)
  }
  stale('ai_runs', lost)
  await sweep()
  assert.deepEqual(state('ai_runs', lost), { status: 'paused', gen: RUN_STALL_REQUEUE_MAX, pause_reason: 'stalled' })
})

await ok('a run the queue refuses is paused, not left pending', async () => {
  const run = aiRun(10)
  await sweep(async () => { throw new Error('queue down') })
  assert.deepEqual(state('ai_runs', run), { status: 'paused', gen: 1, pause_reason: 'stalled' })
})

if (failures) { console.error(`${failures} stalled-runs assertion(s) failed`); process.exit(1) }
console.log('All stalled-runs assertions passed.')
process.exit(0)

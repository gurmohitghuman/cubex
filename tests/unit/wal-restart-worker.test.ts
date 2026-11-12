// The WAL checkpoint worker starts the WAL over after a checkpoint that copied every frame, before it answers
// (lib/wal-checkpoint-worker.ts): the API thread's next write then adds to it, instead of starting it over and
// syncing its new header inside its commit, on the event loop (a transform page after each wait did, 34 a pass).
// The worker's write rewrites user_version with the value it holds: that value, a sheet's data_version and
// updated_at stay as they were. A reader on another connection still on the old frames keeps SQLite from starting
// over (the write adds a frame, and the checkpoint after the reader ends starts it over); a writer holding the
// lock is met without waiting for it (busy_timeout, 5 s, otherwise). Each case checks the WAL itself (its frames,
// and the header SQLite rewrites on starting over: sqlite-write-probe.ts), never timing, save the lock case's
// bound well under that 5 s.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import walMod from '../../server/src/lib/wal-checkpointer'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { checkpointInBackground, closeWalCheckpointer, takeWalCheckpointerStats, walState } =
  walMod as typeof import('../../server/src/lib/wal-checkpointer')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  .run(sid, tid, uid, 'S', 0, JSON.stringify(['N']))
db.pragma('user_version = 7')
const probe = sqliteWriteProbe(db, process.env.DB_PATH!)
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
let next = 0
// `count` rows in one transaction on the API connection, as a page would write them.
const write = db.transaction((count: number) => {
  for (let i = 0; i < count; i++, next++) insert.run(uuid(), sid, uid, next, JSON.stringify({ N: 'n'.repeat(400) }))
})
const sheetNow = () => db.prepare('SELECT data_version, updated_at FROM sheets WHERE id = ?').get(sid)
const other = () => new Database(process.env.DB_PATH!)

async function main() {
  await check('after a checkpoint that copied every frame the WAL starts over on the worker, before it answers: '
    + 'the next write on the API connection adds to it, and nothing Cubex reads changed', async () => {
    probe.reset()
    write.immediate(200)
    const before = walState()!
    assert.ok(before.log > 20 && before.checkpointed < before.log, JSON.stringify(before))
    const sheet = sheetNow()
    takeWalCheckpointerStats()
    const r = await checkpointInBackground()
    // At or past what was written: the worker's own start may write too (its connection's PRAGMA optimize).
    assert.ok(r && r.checkpointed === r.log && r.log >= before.log, JSON.stringify(r))
    assert.equal(takeWalCheckpointerStats().restarts, 1)
    assert.deepEqual(walState(), { log: 1, checkpointed: 0 }, 'the WAL holds only the worker\'s own write')
    assert.equal(db.pragma('user_version', { simple: true }), 7)
    const fresh = other()
    assert.equal(fresh.pragma('user_version', { simple: true }), 7)
    fresh.close()
    assert.deepEqual(sheetNow(), sheet)
    write.immediate(10)
    const last = probe.records().at(-1)!
    assert.equal(last.startedOver, false, transactionLine(last))
    assert.equal(last.before.log, 1)
  })

  await check('a reader on another connection still on the old frames: the worker\'s write adds a frame instead '
    + '(SQLite won\'t start over under it); the checkpoint after the reader ends starts the WAL over', async () => {
    write.immediate(200)
    const reader = other()
    reader.prepare('BEGIN').run()
    reader.prepare('SELECT count(*) FROM rows').get()
    const held = walState()!
    takeWalCheckpointerStats()
    await checkpointInBackground()
    assert.equal(takeWalCheckpointerStats().restarts, 0)
    assert.deepEqual(walState(), { log: held.log + 1, checkpointed: held.log })
    reader.prepare('COMMIT').run()
    reader.close()
    await checkpointInBackground()
    assert.equal(takeWalCheckpointerStats().restarts, 1)
    assert.deepEqual(walState(), { log: 1, checkpointed: 0 })
  })

  await check('a writer on another connection holding the lock: the worker answers without waiting for it, the '
    + 'WAL copied but not started over; a checkpoint once it is done starts it over', async () => {
    write.immediate(200)
    const holder = other()
    holder.prepare('BEGIN IMMEDIATE').run()
    const held = walState()!
    takeWalCheckpointerStats()
    const t0 = performance.now()
    await checkpointInBackground()
    const ms = performance.now() - t0
    assert.ok(ms < 2000, `answered after ${Math.round(ms)} ms: it waited for the lock`)
    assert.equal(takeWalCheckpointerStats().restarts, 0)
    assert.deepEqual(walState(), { log: held.log, checkpointed: held.log })
    holder.prepare('COMMIT').run()
    holder.close()
    write.immediate(10)
    await checkpointInBackground()
    assert.equal(takeWalCheckpointerStats().restarts, 1)
    assert.deepEqual(walState(), { log: 1, checkpointed: 0 })
  })
  await closeWalCheckpointer()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All wal-restart-worker assertions passed.')
    process.exit(0)
  })

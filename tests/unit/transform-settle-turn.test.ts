// transform_column's data_version write after a call (settle, services/column-transform-end.ts) is made in turn with
// the checkpoint worker as its pages are (lib/wal-turn.ts): an immediate transaction whose first statement checks the
// WAL, so every frame copied between its read of the WAL and its BEGIN ends it unwritten, and it asks the worker to
// start the WAL over. Past the call's deadline it must still be made: finding every frame copied, it asks the worker
// once and waits for that answer, so the WAL is started over there, not in its own commit here (a slow disk's
// checkpoint outlasting a call left this write doing it). Each case reads the WAL itself (sqlite-write-probe.ts).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import endMod from '../../server/src/services/column-transform-end'
import walMod from '../../server/src/lib/wal-checkpointer'
import turnMod from '../../server/src/lib/wal-turn'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { settle } = endMod as typeof import('../../server/src/services/column-transform-end')
const { checkpointAsked, checkpointInBackground, closeWalCheckpointer, setWritesWaitForCheckpointsForTests,
  takeWalCheckpointerStats, walCheckpointerIdle, walState } =
  walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { closeWalTurnReader, setBeforeTurnWriteForTests, takeWalTurnStats } =
  turnMod as typeof import('../../server/src/lib/wal-turn')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
// The turns themselves, on every platform (wal-checkpoint-waits.test.ts covers the wait for a running checkpoint).
setWritesWaitForCheckpointsForTests(false)
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
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
let next = 0
// Frames for the worker to copy: 200 rows in one transaction on the API connection.
const fill = db.transaction(() => {
  for (let i = 0; i < 200; i++, next++) insert.run(uuid(), sid, uid, next, JSON.stringify({ N: 'n'.repeat(400) }))
})
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
const version = () => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(sid) as number
const other = () => new Database(process.env.DB_PATH!)

// A fresh window: the WAL holds 200 rows' frames, none copied; the numbers zeroed.
async function fresh() {
  await walCheckpointerIdle()
  probe.reset()
  fill.immediate()
  takeWalCheckpointerStats()
  takeWalTurnStats()
}
// What settle did since `since`: its numbers, and the transactions on the API connection that started the WAL over.
function after(since: number) {
  const startedOver = probe.records().filter(r => r.at >= since && r.startedOver).map(transactionLine)
  const t = takeWalTurnStats()
  return { startedOver, numbers: { ...t, restarts: takeWalCheckpointerStats().restarts } }
}

async function main() {
  await check('every frame copied between its read of the WAL and its BEGIN: its transaction ends unwritten, it asks '
    + 'the worker to start the WAL over, then writes', async () => {
    await fresh()
    const conn = other()
    setBeforeTurnWriteForTests(() => { setBeforeTurnWriteForTests(null); conn.pragma('wal_checkpoint(PASSIVE)') })
    const v = version()
    const since = performance.now()
    try {
      await settle(sid, uid, Date.now() + 5000)
    } finally { setBeforeTurnWriteForTests(null); conn.close() }
    assert.equal(version(), v + 1)
    const { startedOver, numbers } = after(since)
    assert.deepEqual(startedOver, [], 'transactions that started the WAL over on this thread')
    assert.ok(numbers.caughtInside === 1 && numbers.asks === 1 && numbers.restarts === 1, JSON.stringify(numbers))
  })

  await check('past its deadline, every frame copied (the worker\'s start-over skipped, another connection holding '
    + 'the write lock): it asks the worker once and waits for its answer, then writes', async () => {
    await fresh()
    const holder = other()
    holder.prepare('BEGIN IMMEDIATE').run()
    try { await checkpointInBackground() } finally { holder.prepare('ROLLBACK').run(); holder.close() }
    const s = walState()
    assert.ok(s !== null && s.log > 0 && s.checkpointed === s.log, `the WAL: ${JSON.stringify(s)}`)
    takeWalCheckpointerStats()
    const v = version()
    const since = performance.now()
    await settle(sid, uid, Date.now() - 1)
    assert.equal(version(), v + 1)
    const { startedOver, numbers } = after(since)
    assert.deepEqual(startedOver, [], 'transactions that started the WAL over on this thread')
    assert.ok(numbers.asks === 1 && numbers.restarts === 1, JSON.stringify(numbers))
  })
  await closeWalCheckpointer()
  closeWalTurnReader()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-settle-turn assertions passed.')
    process.exit(0)
  })

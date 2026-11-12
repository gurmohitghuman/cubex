// A run's undo journal written in a transaction that reads before it writes (lib/run-undo/journal.ts: journalFor
// reads the run's journal, then makes it), against another connection (write-lock-kit.ts) that commits between
// that read and the write, or holds the write lock then. Begun DEFERRED, SQLite refuses the write at once with
// "database is locked", long before busy_timeout (5 s, lib/db.ts) would end a wait: what column-trash-refs.test.ts
// hit now and then, its own deferred transaction meeting another connection's write. Begun with .immediate(),
// the write lock is the transaction's from BEGIN: the other connection waits for it, or it waits for the other
// connection to commit, and the journal is written. A deferred transaction whose first statement is a write
// waits for the lock the same way: busy_timeout covers that first lock.
import assert from 'node:assert/strict'
import journalMod from '../../server/src/lib/run-undo/journal'
import { attempt, fixture, rivalKit } from './write-lock-kit'
const { journalRowWrite, journalSeed } = journalMod as typeof import('../../server/src/lib/run-undo/journal')

const { db, uid, ok, done, sheet } = fixture('write lock: run journal')
const rival = await rivalKit()
const busyMs = db.pragma('busy_timeout', { simple: true }) as number
// journalFor's first read: the run's journal, before it makes one.
const journalRead = /^SELECT id, columns, stamp_path, state FROM run_undos/
// How long the other connection keeps the write lock in the "holds" cases.
const HOLD_MS = 400
const S = sheet(['Email'], [{ Email: 'a@x.com' }, { Email: 'b@x.com' }])
let runs = 0
// A new run's journal for row 0 (journalRowWrite, as a run's row result writes it), and whether it was kept.
const journal = () => {
  const ref = { kind: 'http' as const, id: `run-${++runs}` }
  return {
    ref,
    write: () => journalRowWrite(ref, S, uid, 0, [['Email', 'x@y.co']], null),
    kept: () => db.prepare(`SELECT COUNT(*) FROM run_undo_rows u JOIN run_undos j ON j.id = u.undo_id
      WHERE j.run_id = ?`).pluck().get(ref.id) as number,
  }
}
const timed = async <T>(fn: () => T) => {
  const at = Date.now()
  const out = await attempt(fn)
  return { out, ms: Date.now() - at }
}

await ok('deferred: another connection commits after its read, and the write fails at once', async () => {
  assert.equal(busyMs, 5000, 'the connection waits up to 5 s for a lock (lib/db.ts)')
  const j = journal()
  const shot = rival.arm({ inTx: true, sql: journalRead })
  const { out, ms } = await timed(() => db.transaction(j.write).deferred())
  await rival.settled()
  console.log(`  deferred, a commit between: ${JSON.stringify(out)} after ${ms} ms`)
  assert.equal(shot.outcome, 'raced', 'the other connection committed between the read and the write')
  assert.deepEqual(out, { threw: 'SQLITE_BUSY_SNAPSHOT' })
  assert.ok(ms < busyMs / 10, `it failed after ${ms} ms: no wait for the lock`)
  assert.equal(j.kept(), 0)
})

await ok('deferred: another connection holds the write lock after its read, and the write fails at once', async () => {
  const j = journal()
  const shot = rival.arm({ inTx: true, sql: journalRead, hold: HOLD_MS })
  const { out, ms } = await timed(() => db.transaction(j.write).deferred())
  await rival.settled()
  console.log(`  deferred, the lock held for ${HOLD_MS} ms: ${JSON.stringify(out)} after ${ms} ms`)
  assert.equal(shot.outcome, 'raced', 'the other connection took the write lock between the read and the write')
  assert.deepEqual(out, { threw: 'SQLITE_BUSY' })
  assert.ok(ms < HOLD_MS, `it failed after ${ms} ms, before the other connection let the lock go`)
  assert.equal(j.kept(), 0)
})

await ok('immediate: the other connection waits for it, and the journal is kept', async () => {
  const j = journal()
  const shot = rival.arm({ inTx: true, sql: journalRead })
  const { out, ms } = await timed(() => db.transaction(j.write).immediate())
  await rival.settled()
  console.log(`  immediate, a commit tried between: ${JSON.stringify(out)} after ${ms} ms`)
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
  assert.deepEqual(out, { value: true })
  assert.equal(j.kept(), 1)
})

await ok('immediate: it waits for a lock another connection holds, then keeps the journal', async () => {
  const j = journal()
  // The other connection takes the write lock right after this read, before the transaction begins.
  const shot = rival.arm({ inTx: false, sql: /^SELECT 1 AS ready$/, hold: HOLD_MS })
  db.prepare('SELECT 1 AS ready').get()
  assert.equal(shot.outcome, 'raced', 'the other connection holds the write lock')
  const { out, ms } = await timed(() => db.transaction(j.write).immediate())
  await rival.settled()
  console.log(`  immediate, the lock held for ${HOLD_MS} ms: ${JSON.stringify(out)} after ${ms} ms`)
  assert.deepEqual(out, { value: true })
  assert.ok(ms >= HOLD_MS / 2 && ms < busyMs, `it waited ${ms} ms for the lock, within busy_timeout`)
  assert.equal(j.kept(), 1)
})

await ok('deferred with a write first: it waits for a lock another connection holds, as an immediate one', async () => {
  const j = journal()
  const shot = rival.arm({ inTx: false, sql: /^SELECT 1 AS ready$/, hold: HOLD_MS })
  db.prepare('SELECT 1 AS ready').get()
  assert.equal(shot.outcome, 'raced', 'the other connection holds the write lock')
  const { out, ms } = await timed(() => db.transaction(() => {
    db.prepare("UPDATE sheets SET updated_at = datetime('now') WHERE id = ?").run(S)
    return j.write()
  }).deferred())
  await rival.settled()
  console.log(`  deferred with a write first, the lock held for ${HOLD_MS} ms: ${JSON.stringify(out)} after ${ms} ms`)
  assert.deepEqual(out, { value: true })
  assert.ok(ms >= HOLD_MS / 2 && ms < busyMs, `it waited ${ms} ms for the lock, within busy_timeout`)
  assert.equal(j.kept(), 1)
})

await ok("a run's seeding journal begun immediate meets a commit after its read, and is kept", async () => {
  const j = journal()
  const rowids = JSON.stringify(db.prepare('SELECT rowid FROM rows WHERE sheet_id = ?').pluck().all(S))
  const shot = rival.arm({ inTx: true, sql: journalRead })
  const out = await attempt(() => db.transaction(() => journalSeed(j.ref, S, uid, { rowids },
    [['Email', '⏳ Processing...']])).immediate())
  await rival.settled()
  assert.equal(shot.outcome, 'blocked', 'it held the write lock from its start')
  assert.deepEqual(out, { value: undefined })
  assert.equal(j.kept(), 2)
})

await rival.stop()
done()

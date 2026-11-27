// Over 200 lines: one fixture (20,000 rows rewritten) and the runner's edges, read top to bottom.
// The background bulk writers' runner itself (lib/bulk-slices.ts), on a job that rewrites rows with random ids slice
// after slice: its WAL copied back on the worker (no checkpoint, no SQLite checkpoint inside a commit and no WAL
// start-over on the API connection, the loop never held 200 ms, the WAL bounded); SQLite's own checkpoint on the API
// connection at the job's room (the job starts the WAL watch), the watch quiet while runners go and asking again after,
// whatever ends them (a step that throws, a job stopped part way, two at once), a second end or a setting found changed
// logged and set right; with no worker (its file can't load) checkpoints on this thread as before, SQLite's own back at
// DB_AUTO_CHECKPOINT_FRAMES, logged once; a worker stopped mid-job started again; a reader holding the frames doesn't
// stop the job; past a deadline the slices are still written; big slices bring the pause forward, so the WAL stays
// within its share of journal_size_limit; a reader holding the last frames as a job ends doesn't leave them to the next
// commit. A writer outside the runner all through a job: bulk-wal-outside.test.ts.
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import constMod from '../../server/src/lib/constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import bulkMod from '../../server/src/lib/bulk-slices'
import watchMod from '../../server/src/lib/wal-watch'
import { bulkWalKit, SLOW_CHECKPOINT_MS } from './bulk-wal-kit'
import { passed } from './ends-on-its-own'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { DB_AUTO_CHECKPOINT_FRAMES, WAL_BULK_ROOM_SHARE } = constMod as typeof import('../../server/src/lib/constants')
const { checkpointInBackground, closeWalCheckpointer, setCheckpointDelayForTests, setCheckpointWorkerFileForTests,
  stopCheckpointWorkerForTests, takeWalCheckpointerStats, walCheckpointerIdle } =
  walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { asBulkWriter, runInCheckpointedSlices } = bulkMod as typeof import('../../server/src/lib/bulk-slices')
const { bulkWriterRunning, bulkWritersRunning, watchWal } = watchMod as typeof import('../../server/src/lib/wal-watch')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const logged: string[] = []
const quiet = console.error
console.error = (...a: unknown[]) => { logged.push(String(a[0])); if (!/checkpoint/i.test(String(a[0]))) quiet(...a) }
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const { probe, measure } = bulkWalKit()
const auto = () => db.pragma('wal_autocheckpoint', { simple: true }) as number
const page = db.pragma('page_size', { simple: true }) as number
const sizeLimit = db.pragma('journal_size_limit', { simple: true }) as number
// The frames a job may take the WAL to with journal_size_limit at `limit`: SQLite's own checkpoint waits for it.
const roomFor = (limit: number) => Math.floor((WAL_BULK_ROOM_SHARE * limit) / (page + 24))

// 20,000 rows with random ids and about 300 bytes each: a slice of 500 rewrites pages all over the table.
const ROWS = 20_000, SLICE = 500
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'Big', JSON.stringify(['N']))
const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) ins.run(uuid(), sid, uid, i, JSON.stringify({ N: `${i}`, P: 'p'.repeat(300) }))
}).immediate()
const rowids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY id').pluck().all(sid) as number[]
const set = db.prepare(`UPDATE rows SET data = json_set(data, '$.N', ?)
  WHERE rowid IN (SELECT value FROM json_each(?))`)
// A step rewriting every row's N to `v`, `size` rows (in id order, so pages all over) at a time; `after(k)` runs
// once slice k is written and may throw, or answer false to stop there.
const rewrite = (v: string, after: (k: number) => boolean | void = () => true, size = SLICE) => {
  let i = 0, k = 0
  return () => {
    set.run(v, JSON.stringify(rowids.slice(i, i + size)))
    i += size
    return after(++k) !== false && i < rowids.length
  }
}
const count = (v: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.N') = ?`).pluck().get(sid, v) as number
// No runner counted, and SQLite's own checkpoint as the watch sets it (its next look, made here): the room, or
// DB_AUTO_CHECKPOINT_FRAMES once checkpoints run on this thread.
const back = (onWorker = true) => {
  watchWal()
  assert.equal(auto(), onWorker ? roomFor(sizeLimit) : DB_AUTO_CHECKPOINT_FRAMES, 'SQLite\'s own checkpoint')
  assert.equal(bulkWritersRunning(), 0)
}

// The setting read every 2 ms, so between slices (a slice itself commits with it at 0).
await ok('a job: its WAL copied back on the worker, waiting at the pause; SQLite\'s own checkpoint at its room',
  async () => {
    const seen: number[] = []
    await measure('rewrite', async () => {
      const sampler = setInterval(() => seen.push(auto()), 2)
      try { await runInCheckpointedSlices(rewrite('a')) } finally { clearInterval(sampler) }
    }, { pause: true })
    assert.equal(count('a'), ROWS)
    assert.ok(seen.length > 0 && seen.every(v => v === roomFor(sizeLimit)), `seen ${[...new Set(seen)]}`)
  })

await ok('a step that throws: the error comes out, the runner no longer counted', async () => {
  await assert.rejects(runInCheckpointedSlices(rewrite('b', k => { if (k === 3) throw new Error('step 3') })),
    /step 3/)
  back()
  assert.equal(count('b'), 2 * SLICE, 'the slice that threw is rolled back')
})

await ok('a job stopped part way (its step answers false, or its work ends between slices): not counted', async () => {
  await runInCheckpointedSlices(rewrite('c', k => k < 4))
  back()
  assert.equal(count('c'), 4 * SLICE)
  await assert.rejects(asBulkWriter(async w => {
    const step = rewrite('d')
    await w.slice(step)
    await w.slice(step)
    throw new Error('cancelled')
  }), /cancelled/)
  back()
})

await ok('two at once: counted until both end', async () => {
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  const first = asBulkWriter(async w => { await w.slice(rewrite('e')); await held })
  try {
    await new Promise(r => setTimeout(r, 20))
    await runInCheckpointedSlices(rewrite('f', k => k < 2))
    assert.equal(auto(), roomFor(sizeLimit))
    assert.equal(bulkWritersRunning(), 1, 'the first is going')
  } finally {
    release()
    await first
  }
  back()
})

await ok('ended twice, or SQLite\'s own found changed: logged, and set right', async () => {
  logged.length = 0
  const ended = bulkWriterRunning()
  ended()
  ended()
  back()
  assert.equal(logged.filter(l => /twice/.test(l)).length, 1, logged.join('\n'))
  db.pragma('wal_autocheckpoint = 0')
  await runInCheckpointedSlices(rewrite('g', k => k < 2))
  back()
  assert.equal(logged.filter(l => /with the WAL watch running/.test(l)).length, 1, logged.join('\n'))
})

await ok('no worker (its file can\'t load): checkpoints on this thread, SQLite\'s own back at 2,000, logged once',
  async () => {
  await closeWalCheckpointer()
  setCheckpointWorkerFileForTests('/nonexistent/wal-checkpoint-worker.js')
  logged.length = 0
  takeWalCheckpointerStats()
  try {
    await runInCheckpointedSlices(rewrite('h'))
    assert.equal(count('h'), ROWS)
    back(false)
    const k = takeWalCheckpointerStats()
    assert.ok(k.onThisThread > 0, JSON.stringify(k))
    assert.equal(logged.filter(l => /checkpoint worker/.test(l)).length, 1, logged.join('\n'))
  } finally { setCheckpointWorkerFileForTests(null) }
})

await ok('the worker stopped mid-job: started again, the job ends on it', async () => {
  takeWalCheckpointerStats()
  await runInCheckpointedSlices(rewrite('i', k => { if (k === 10) void stopCheckpointWorkerForTests() }))
  assert.equal(count('i'), ROWS)
  back()
  const k = takeWalCheckpointerStats()
  assert.ok(k.starts >= 1 && k.onThisThread === 0, JSON.stringify(k))
})

// Slices of 20 rows, about a millisecond each: past the pause, one wait a slice would be hundreds.
await ok('a reader holding the frames: the job goes on (the WAL grows meanwhile), waiting every 25 ms at most',
  async () => {
    const reader = new Database(process.env.DB_PATH!, { readonly: true })
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM rows').get()
    takeWalCheckpointerStats()
    const t0 = Date.now()
    try { await runInCheckpointedSlices(rewrite('j', () => true, 20)) } finally {
      reader.exec('COMMIT')
      reader.close()
    }
    const ms = Date.now() - t0
    assert.equal(count('j'), ROWS)
    const k = takeWalCheckpointerStats()
    console.log(`      held: ${ROWS / 20} slices in ${ms} ms, ${k.pauses} waits, ${k.checkpoints} checkpoints`)
    assert.ok(k.pauses > 0 && k.pauses <= ms / 25 + 2, `${k.pauses} waits in ${ms} ms`)
    back()
  })

await ok('past its deadline: no more waits for the worker, every slice still written', async () => {
  await asBulkWriter(async w => { const step = rewrite('k'); while (await w.slice(step)) { /* next */ } }, Date.now())
  assert.equal(count('k'), ROWS)
  back()
})

// journal_size_limit at 8 MB for one job: slices of 2,000 rows (about 1,100 frames) bring its pause to a few
// hundred frames.
await ok('big slices: the pause comes sooner, the WAL within its share of journal_size_limit', async () => {
  const limit = db.pragma('journal_size_limit', { simple: true }) as number
  const small = 8 * 1024 * 1024
  db.pragma(`journal_size_limit = ${small}`)
  try {
    const room = roomFor(small)
    const r = await measure('big slices', () => runInCheckpointedSlices(rewrite('l', () => true, 2_000)))
    assert.equal(count('l'), ROWS)
    assert.ok(r.w.mostTransactionFrames > room / 2, `slices of ${r.w.mostTransactionFrames} frames`)
    assert.ok(r.w.mostWalFrames <= room && r.k.pauses > 0, `${r.w.mostWalFrames} frames (room for ${room}), `
      + `${r.k.pauses} waits`)
  } finally { db.pragma(`journal_size_limit = ${limit}`) }
})

// A reader on another connection opened in the last slice, held longer than a checkpoint takes: the first try
// copies only the frames before it, the next the rest, and starts the WAL over before SQLite's own checkpoint
// comes back on (measure's next commit neither checkpoints nor starts the WAL over).
await ok('a reader holding the last frames as the job ends: tried again, the WAL started over first', async () => {
  const reader = new Database(process.env.DB_PATH!, { readonly: true })
  let gone: Promise<void> = Promise.resolve()
  try {
    const r = await measure('a reader at the end', () => runInCheckpointedSlices(rewrite('m', k => {
      if (k < ROWS / SLICE) return
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM rows').get()
      gone = new Promise(res => setTimeout(() => { reader.exec('COMMIT'); res() }, SLOW_CHECKPOINT_MS + 100))
    })))
    assert.equal(count('m'), ROWS)
    assert.ok(r.k.checkpoints >= 2, JSON.stringify(r.k))
  } finally {
    await gone
    reader.close()
  }
})

await closeWalCheckpointer()
if (failures > 0) { console.error(`${failures} bulk-wal-runner assertion(s) failed`); process.exit(1) }
console.log('All bulk-wal-runner assertions passed.')
passed()

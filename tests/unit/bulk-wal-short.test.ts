// A short bulk job leaves the WAL as it found it (lib/bulk-slices.ts): a run started on 10 rows (services/run-seed.ts,
// its ⏳ seeded through lib/row-order.ts) ends with fewer frames in the WAL than SQLite's own checkpoint waits for,
// so it neither asks the worker for a checkpoint nor waits for one, however slow the disk (each checkpoint on the
// worker held 5 s here): the run is queued at once. A job that leaves 2,000 frames or more still waits for the
// worker to copy them back and start the WAL over, so the next commit on this connection does neither; and so does a
// big job whose WAL started over part way and ends under 2,000 frames (the next commit would take it past).
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet, cells } = undoKit('bulk-wal-short')
const { seedThenEnqueue } = await import('../../server/src/services/run-seed')
const { withSheetBusy } = await import('../../server/src/lib/sheet-busy')
const { asBulkWriter } = await import('../../server/src/lib/bulk-slices')
const { bulkWritersRunning } = await import('../../server/src/lib/wal-watch')
const { DB_AUTO_CHECKPOINT_FRAMES } = await import('../../server/src/lib/constants')
const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { checkpointInBackground, closeWalCheckpointer, setCheckpointDelayForTests, takeWalCheckpointerStats,
  walCheckpointerIdle, walState } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}

// The worker started, the WAL copied back and started over, the counts zeroed: a server up a while.
async function fresh() {
  await checkpointInBackground()
  await walCheckpointerIdle()
  takeWalCheckpointerStats()
}

await ok('a run started on 10 rows: queued at once, no checkpoint asked of the worker', async () => {
  const sid = sheet(Array.from({ length: 10 }, (_, i) => ({ Name: `n${i}` })), ['Name', 'Answer'])
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,placeholder_work)
    VALUES (?,?,?,'Answer','p','pending','seeding')`).run(id, sid, uid)
  await fresh()
  let queuedMs = -1
  setCheckpointDelayForTests(5_000)
  try {
    const t0 = performance.now()
    await withSheetBusy(sid, 'starting a run', async () => {
      seedThenEnqueue({ kind: 'ai', runId: id, sheetId: sid, userId: uid, columns: ['Answer'], targets: null,
        lastRow: 9, enqueue: async () => { queuedMs = performance.now() - t0 } })
    })
    await idle(sid)
  } finally {
    setCheckpointDelayForTests(0)
  }
  console.log(`      queued after ${queuedMs.toFixed(0)} ms`)
  assert.ok(queuedMs >= 0 && queuedMs < 1_000, `queued after ${queuedMs.toFixed(0)} ms`)
  assert.equal(takeWalCheckpointerStats().checkpoints, 0, 'checkpoints on the worker')
  assert.equal(bulkWritersRunning(), 0)
  assert.deepEqual(cells(sid, 'Answer'), Array(10).fill(PLACEHOLDER))
  // Its frames stay in the WAL for SQLite's own checkpoint, as with no runner.
  const w = walState()!
  assert.ok(w.log > 0 && w.log < DB_AUTO_CHECKPOINT_FRAMES && w.checkpointed < w.log, JSON.stringify(w))
})

await ok('a job leaving 2,000 frames or more: it waits for the worker, the WAL started over after it', async () => {
  const sid = sheet(Array.from({ length: 20_000 }, (_, i) => ({ Name: `n${i}`, P: 'p'.repeat(500) })), ['Name', 'P'])
  await fresh()
  const set = db.prepare(`UPDATE rows SET data = json_set(data, '$.Name', 'x') WHERE sheet_id = ?`)
  let frames = 0
  setCheckpointDelayForTests(300)
  const t0 = performance.now()
  try {
    await asBulkWriter(async w => {
      await w.slice(() => set.run(sid))
      frames = walState()!.log
    })
  } finally {
    setCheckpointDelayForTests(0)
  }
  assert.ok(frames >= DB_AUTO_CHECKPOINT_FRAMES, `${frames} frames`)
  assert.ok(performance.now() - t0 >= 300, 'it waited for the worker')
  const s = takeWalCheckpointerStats()
  assert.ok(s.checkpoints >= 1 && s.restarts >= 1, JSON.stringify(s))
  // Started over by the worker's write (lib/wal-turn.ts): its one frame.
  assert.ok(walState()!.log <= 1, `the WAL started over (${walState()!.log} frames)`)
})

await ok('a big job ending under 2,000 frames, the WAL started over part way: it still waits', async () => {
  const sid = sheet(Array.from({ length: 20_000 }, (_, i) => ({ Name: `n${i}`, P: 'p'.repeat(500) })), ['Name', 'P'])
  await fresh()
  const all = db.prepare(`UPDATE rows SET data = json_set(data, '$.Name', 'x') WHERE sheet_id = ?`)
  const some = db.prepare(`UPDATE rows SET data = json_set(data, '$.Name', 'y') WHERE sheet_id = ? AND row_index < ?`)
  let last = 0
  await asBulkWriter(async w => {
    await w.slice(() => all.run(sid))
    // The worker copies the first slice back and starts the WAL over before the next.
    await fresh()
    const from = walState()!.log
    await w.slice(() => some.run(sid, 8_000))
    last = walState()!.log - from
  })
  assert.ok(last >= DB_AUTO_CHECKPOINT_FRAMES / 2 && last < DB_AUTO_CHECKPOINT_FRAMES, `last slice: ${last} frames`)
  const s = takeWalCheckpointerStats()
  assert.ok(s.checkpoints >= 1 && s.restarts >= 1, `the job didn't wait for the worker: ${JSON.stringify(s)}`)
  assert.ok(walState()!.log <= 1, `the WAL started over (${walState()!.log} frames)`)
})

await closeWalCheckpointer()
done()

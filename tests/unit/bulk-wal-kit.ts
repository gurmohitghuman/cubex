// A background bulk writer measured (lib/bulk-slices.ts), for the bulk-wal-*.test.ts files: the real job with each
// checkpoint on the worker held 300 ms first (setCheckpointDelayForTests, as a slow disk's syncs would) and disk
// syncs as the server has them. The event loop's longest stretch is sampled every 5 ms, its bound applied to what
// this thread held alone (a pause of the whole process let off, loop-watch.ts); the API connection is
// watched (sqlite-write-probe.ts) for any checkpoint it ran, any commit that ran SQLite's own checkpoint and any
// that started the WAL over. With none of those, no checkpoint's disk sync ran on the API thread. Also the WAL's
// peak against journal_size_limit, SQLite's own checkpoint at the room afterwards (the WAL watch runs), and the
// next commit there neither checkpointing nor starting the WAL over (the job left the WAL started over). Each
// measure prints its numbers (on a pass too, so a Windows run keeps them) and the transactions inside its longest
// stretch. Bulk writers the job left going in the background (an undo dropping its journal) are waited for and
// measured with it.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import dbMod from '../../server/src/lib/db'
import constMod from '../../server/src/lib/constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import watchMod from '../../server/src/lib/wal-watch'
import roomMod from '../../server/src/lib/wal-room'
import { sqliteWriteProbe, transactionLine } from './sqlite-write-probe'
import { heldText, loopWatch, type LoopWatched } from './loop-watch'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { DB_AUTO_CHECKPOINT_FRAMES, WAL_BULK_PAUSE_FRAMES } = constMod as typeof import('../../server/src/lib/constants')
const { checkpointAsked, checkpointInBackground, setCheckpointDelayForTests, takeWalCheckpointerStats,
  walCheckpointerIdle } = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { bulkWritersRunning } = watchMod as typeof import('../../server/src/lib/wal-watch')
const { walRoomFrames } = roomMod as typeof import('../../server/src/lib/wal-room')

export const SLOW_CHECKPOINT_MS = 300
// The event loop's longest stretch allowed while a bulk writer runs, by this thread alone (loop-watch.ts).
export const LOOP_LIMIT_MS = 200

// The event loop's longest stretch, told from the whole process paused (loop-watch.ts).
export { heldText, loopWatch } from './loop-watch'

export function bulkWalKit() {
  const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const sizeLimit = db.pragma('journal_size_limit', { simple: true }) as number
  const auto = () => db.pragma('wal_autocheckpoint', { simple: true }) as number
  db.exec('CREATE TABLE IF NOT EXISTS bulk_wal_after (id INTEGER PRIMARY KEY)')
  const after = db.prepare('INSERT INTO bulk_wal_after DEFAULT VALUES')
  // Transactions opened inside a slice while the job runs (where each was called): a slice is one transaction
  // already (lib/bulk-slices.ts makes it), and one nested in it is a savepoint, which keeps every statement's pages
  // in SQLite's statement journal (lib/slices.ts, oneTransaction). Transaction functions made before the job aren't
  // seen.
  const realTransaction = db.transaction
  let nested: string[] = []
  let inSlice = 0
  // `turns`: the event loop's turns counted (an immediate that sets the next), and slices written in a turn another
  // slice was written in (lib/slice-turn.ts allows one a turn): none served between them.
  let turn = 0
  let spinning = false
  let sliceTurn = -1
  let sharedTurns = 0
  const spin = () => { turn++; if (spinning) setImmediate(spin) }
  const watchNesting = (on: boolean) => {
    db.transaction = !on ? realTransaction : ((fn: (...a: unknown[]) => unknown) => {
      const t = realTransaction.call(db, fn) as unknown as Record<string, (...a: unknown[]) => unknown>
      const slice = /bulk-slices\.[jt]s/.test(new Error().stack!)
      const seen = (call: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
        if (inSlice > 0) nested.push(new Error().stack!.split('\n')[2].trim())
        if (!slice) return call(...a)
        if (turn === sliceTurn) sharedTurns++
        sliceTurn = turn
        inSlice++
        try { return call(...a) } finally { inSlice-- }
      }
      const w = seen(t as unknown as (...a: unknown[]) => unknown) as unknown as Record<string, unknown>
      for (const k of ['default', 'deferred', 'immediate', 'exclusive']) w[k] = seen(t[k])
      return w
    }) as unknown as typeof db.transaction
  }

  // `pause`: the job writes enough for the WAL to reach WAL_BULK_PAUSE_FRAMES, so it waits for the worker.
  // `pastAuto`: enough for it to pass DB_AUTO_CHECKPOINT_FRAMES, where a commit with SQLite's own checkpoint on
  // would copy the WAL back inside it. `turns`: no two slices written in one turn of the event loop.
  async function measure(
    label: string, job: () => Promise<unknown>, opts: { pause?: boolean; pastAuto?: boolean; turns?: boolean } = {},
  ) {
    // The worker started first: starting it isn't part of the job.
    await checkpointInBackground()
    await walCheckpointerIdle()
    probe.reset()
    takeWalCheckpointerStats()
    const watch = loopWatch(probe.records)
    await watch.ready
    let watched: LoopWatched | undefined
    setCheckpointDelayForTests(SLOW_CHECKPOINT_MS)
    nested = []
    sharedTurns = 0
    sliceTurn = -1
    if (opts.turns) { spinning = true; spin() }
    watchNesting(true)
    const t0 = performance.now()
    let ms = 0
    try {
      await job()
      ms = performance.now() - t0
      // What the job left going in the background (an undo drops its journal so) is measured too.
      for (const end = Date.now() + 120_000; bulkWritersRunning() > 0 && Date.now() < end;) {
        await new Promise(r => setTimeout(r, 5))
      }
    } finally {
      watched = watch()
      spinning = false
      watchNesting(false)
      setCheckpointDelayForTests(0)
    }
    await walCheckpointerIdle()
    // The next commit on the API connection: the job left nothing for it to copy back and the WAL started over, so
    // it neither checkpoints nor starts the WAL over itself.
    db.transaction(() => { after.run() }).immediate()
    const w = probe.read()
    const k = takeWalCheckpointerStats()
    const records = probe.records()
    const { inside } = watched
    const peakBytes = 32 + w.mostWalFrames * (pageSize + 24)
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1)
    console.log(`      ${label}: ${(ms / 1000).toFixed(1)} s, ${heldText(watched)}, `
      + `${w.transactions} transactions (longest ${w.longestTransactionMs.toFixed(0)} ms, most frames `
      + `${w.mostTransactionFrames}), worker: ${k.checkpoints} checkpoints, ${k.pauses} waits (${k.pausedMs} ms), `
      + `${k.restarts} start-overs; WAL peak ${w.mostWalFrames} frames, ${mb(peakBytes)} MB of ${mb(sizeLimit)} `
      + `(${(100 - (peakBytes / sizeLimit) * 100).toFixed(0)}% left)`)
    const held = inside.map(transactionLine).join(' | ')
    console.log(`        in the stretch this thread held longest: ${held || 'no transaction'}`)
    if (opts.turns) console.log(`        slices written in a turn another slice was written in: ${sharedTurns}`)
    const startedOver = records.filter(r => r.startedOver).map(transactionLine)
    assert.ok(watched.ownMs < LOOP_LIMIT_MS, `the event loop was held ${watched.ownMs.toFixed(0)} ms by this thread`)
    assert.equal(w.checkpoints, 0, 'checkpoints run on the API connection')
    assert.equal(w.ownCheckpoints, 0, 'commits on the API connection that ran SQLite\'s own checkpoint')
    assert.deepEqual(startedOver, [], 'transactions on the API connection that started the WAL over')
    assert.equal(k.onThisThread, 0, 'checkpoints run on this thread')
    assert.ok(peakBytes < sizeLimit, `the WAL peaked at ${peakBytes} bytes, past journal_size_limit`)
    assert.equal(auto(), walRoomFrames(db), 'SQLite\'s own checkpoint waits for the room (the WAL watch runs)')
    assert.equal(bulkWritersRunning(), 0, 'bulk writers still counted as running')
    assert.deepEqual([...new Set(nested)], [], 'transactions nested in a slice (savepoints)')
    if (opts.pastAuto) {
      assert.ok(w.mostWalFrames >= DB_AUTO_CHECKPOINT_FRAMES,
        `the WAL never passed SQLite's own mark (${w.mostWalFrames} frames)`)
    }
    if (opts.turns) assert.equal(sharedTurns, 0, 'slices written in a turn another slice was written in')
    if (opts.pause) {
      assert.ok(w.mostWalFrames >= WAL_BULK_PAUSE_FRAMES && k.pauses > 0,
        `the WAL never reached the pause (${w.mostWalFrames} frames, ${k.pauses} waits)`)
    }
    return { ms, loopMs: watched.ownMs, w, k, records, peakBytes, sharedTurns }
  }
  return { probe, measure }
}

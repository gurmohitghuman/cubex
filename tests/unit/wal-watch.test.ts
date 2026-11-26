// Over 200 lines: one fixture and the watch's cases, each needing the WAL as the one before left it.
// The WAL watch (lib/wal-watch.ts): the checkpoint worker as the only checkpointer. Started, SQLite's own checkpoint
// waits for the room on this connection and on one a thread opens after (it finds the mark in its environment); light
// writes here with gaps, past the room in all, are copied back on the worker and the WAL started over there, no commit
// here running SQLite's own checkpoint and no checkpoint run on this thread; a stream with no gap is copied back on the
// worker too, the WAL started over there once it ends; a writer on another thread (as a run's job), past the room in
// all, never takes the WAL to its own mark; while a bulk writer runs the watch asks nothing, and after it asks again;
// with no worker, SQLite's own here is back at 2,000, the watch asks nothing and the mark leaves the environment;
// stopped, it is back at 2,000 and the mark gone.
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import dbMod from '../../server/src/lib/db'
import constMod from '../../server/src/lib/constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import watchMod from '../../server/src/lib/wal-watch'
import roomMod from '../../server/src/lib/wal-room'
import { sqliteWriteProbe } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { DB_AUTO_CHECKPOINT_FRAMES, WAL_WATCH_MS, WAL_WATCHED_ENV } =
  constMod as typeof import('../../server/src/lib/constants')
const { checkpointAsked, closeWalCheckpointer, setCheckpointWorkerFileForTests, takeWalCheckpointerStats,
  walCheckpointerIdle, walState } = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { bulkWriterRunning, startWalWatch, stopWalWatch, watchWal } =
  watchMod as typeof import('../../server/src/lib/wal-watch')
const { walRoomFrames } = roomMod as typeof import('../../server/src/lib/wal-room')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
console.warn = () => {}
const logged: string[] = []
console.error = (...a: unknown[]) => { logged.push(String(a[0])) }
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const requireHere = createRequire(import.meta.url)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const auto = () => db.pragma('wal_autocheckpoint', { simple: true }) as number
db.exec('CREATE TABLE IF NOT EXISTS watch_rows (id INTEGER PRIMARY KEY, v TEXT)')
const big = 'x'.repeat(3000)
const insert = db.prepare('INSERT INTO watch_rows (v) VALUES (?)')
const probe = sqliteWriteProbe(db, process.env.DB_PATH!, checkpointAsked)
// The WAL copied back and started over, nothing asked still running: a clean start for the next case.
async function settled() {
  await walCheckpointerIdle()
  db.pragma('wal_checkpoint(TRUNCATE)')
  takeWalCheckpointerStats()
}

// A thread with its own connection (lib/db.ts), as a run's job has: `body` runs there with `db` and `send`.
function onAThread<T>(body: string): Promise<T> {
  const tsx = requireHere.resolve('tsx/cjs/api')
  const dbFile = requireHere.resolve('../../server/src/lib/db')
  const code = `require(${JSON.stringify(tsx)}).register();
    const { parentPort } = require('node:worker_threads');
    const { db } = require(${JSON.stringify(dbFile)});
    const send = m => parentPort.postMessage(m);
    (async () => { ${body} })().catch(e => send({ error: String(e && e.stack || e) }));`
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true })
    w.once('message', m => { void w.terminate(); m && m.error ? reject(new Error(m.error)) : resolve(m) })
    w.once('error', reject)
  })
}

startWalWatch()
const room = walRoomFrames(db)

await ok('started: SQLite\'s own checkpoint waits for the room here and on a connection a thread opens after',
  async () => {
  assert.ok(room > DB_AUTO_CHECKPOINT_FRAMES * 5, `${room} frames`)
  assert.equal(auto(), room)
  assert.equal(process.env[WAL_WATCHED_ENV], process.env.DB_PATH)
  const theirs = await onAThread<number>(`send(db.pragma('wal_autocheckpoint', { simple: true }))`)
  assert.equal(theirs, room)
})

// Commits of one 3 KB row (about 3 frames each), `gapMs` after every 25 (0: a yield only, so the watch's timer
// still fires), until `frames` frames are written. What the probe saw and the worker did.
async function writeHere(frames: number, gapMs: number) {
  await settled()
  probe.reset()
  let written = 0
  for (let i = 0; written < frames; i++) {
    const before = walState()!.log
    db.transaction(() => { insert.run(big) }).immediate()
    const after = walState()!.log
    written += after > before ? after - before : after
    if (i % 25 === 24) await sleep(gapMs)
  }
  await sleep(WAL_WATCH_MS + 100)
  await walCheckpointerIdle()
  const w = probe.read()
  const k = takeWalCheckpointerStats()
  console.log(`      ${w.transactions} commits, ${written} frames, WAL peak ${w.mostWalFrames} frames; worker: `
    + `${k.checkpoints} checkpoints, ${k.restarts} start-overs`)
  return { w, k }
}

// About 1,500 frames a second, still far more than autosaves and webhooks write; past the room in all, so SQLite's
// own checkpoint here would have run if the worker hadn't started the WAL over on the way.
await ok('light writes here, with gaps: the worker copies them back and starts the WAL over; nothing here',
  async () => {
    const { w, k } = await writeHere(room + 3000, 40)
    assert.ok(k.checkpoints >= 1 && k.restarts >= 1 && k.onThisThread === 0, JSON.stringify(k))
    assert.equal(w.checkpoints, 0, 'checkpoints run on this connection')
    assert.equal(w.ownCheckpoints, 0, 'commits here that ran SQLite\'s own checkpoint')
    assert.ok(w.mostWalFrames < room, `the WAL reached ${w.mostWalFrames} frames`)
  })

// A stream with no gap (a yield every 25 commits only): a commit often lands during the worker's checkpoint, which
// then can't start the WAL over; the watch asks again at each look while the WAL is past the mark. How high the WAL
// gets depends on the disk (at the room SQLite's own checkpoint here is the backstop), so the peak is printed, not
// held to a number. What holds on any disk: no checkpoint run on this thread, and once the stream ends the WAL is
// started over on the worker.
await ok('a stream with no gap: copied back on the worker, started over there once it ends, nothing on this thread',
  async () => {
    const { w, k } = await writeHere(room + 3000, 0)
    assert.ok(k.checkpoints >= 2 && k.onThisThread === 0, JSON.stringify(k))
    assert.equal(w.checkpoints, 0, 'checkpoints run on this connection')
    const s = walState()!
    assert.ok(s.log < DB_AUTO_CHECKPOINT_FRAMES, `the WAL ended at ${JSON.stringify(s)}`)
  })

// Its connection's WAL size read after each of its commits: SQLite's own checkpoint runs only in a commit that
// leaves the WAL at its mark or past it, so a most under the room means none ran on that thread. It writes past the
// room in all (6,000 rows, with gaps as a run's results come), so that holds only if the watch had the worker start
// the WAL over on the way.
await ok('a writer on another thread: never at its own mark, what it wrote copied back on the worker', async () => {
  await settled()
  const theirs = await onAThread<{ auto: number; most: number; frames: number }>(`
    const ins = db.prepare('INSERT INTO watch_rows (v) VALUES (?)');
    const state = () => db.pragma('wal_checkpoint(NOOP)')[0];
    let most = 0, frames = 0;
    for (let i = 0; i < 6000; i++) {
      const before = state().log;
      ins.run(${JSON.stringify(big)});
      const after = state().log;
      most = Math.max(most, after);
      frames += after > before ? after - before : after;
      if (i % 25 === 24) await new Promise(r => setTimeout(r, 40));
    }
    send({ auto: db.pragma('wal_autocheckpoint', { simple: true }), most, frames });`)
  await sleep(WAL_WATCH_MS + 100)
  await walCheckpointerIdle()
  const k = takeWalCheckpointerStats()
  console.log(`      the thread wrote ${theirs.frames} frames, the WAL at most ${theirs.most}; worker: `
    + `${k.checkpoints} checkpoints`)
  assert.equal(theirs.auto, room)
  assert.ok(theirs.frames > room, `${theirs.frames} frames`)
  assert.ok(theirs.most < room, `the WAL reached ${theirs.most} frames on that thread`)
  assert.ok(k.checkpoints >= 1 && k.onThisThread === 0, JSON.stringify(k))
  const s = walState()!
  assert.ok(s.checkpointed === s.log || s.log < DB_AUTO_CHECKPOINT_FRAMES, JSON.stringify(s))
})

// 2,500 rows in one commit: past the watch's mark, far under the room.
const pastTheMark = () => db.transaction(() => { for (let i = 0; i < 2500; i++) insert.run(big) }).immediate()

await ok('while a bulk writer runs the watch asks nothing; once it ends, it asks again', async () => {
  await settled()
  pastTheMark()
  const ended = bulkWriterRunning()
  try {
    watchWal()
    assert.equal(checkpointAsked(), false)
  } finally { ended() }
  watchWal()
  assert.equal(checkpointAsked(), true)
  await walCheckpointerIdle()
  const k = takeWalCheckpointerStats()
  assert.ok(k.checkpoints === 1 && k.onThisThread === 0, JSON.stringify(k))
})

// The first look asks, and finds the worker can't start: that checkpoint runs here. From then on the watch asks
// nothing, since on this thread its checkpoints would copy every thread's frames on the event loop.
await ok('no worker (its file can\'t load): SQLite\'s own here back at 2,000, the watch asks nothing, the mark gone',
  async () => {
    await settled()
    await closeWalCheckpointer()
    setCheckpointWorkerFileForTests('/nonexistent/wal-checkpoint-worker.js')
    try {
      pastTheMark()
      watchWal()
      await walCheckpointerIdle()
      watchWal()
      assert.equal(auto(), DB_AUTO_CHECKPOINT_FRAMES)
      assert.equal(process.env[WAL_WATCHED_ENV], undefined)
      const k = takeWalCheckpointerStats()
      assert.equal(k.onThisThread, 1, JSON.stringify(k))
      assert.equal(logged.filter(l => /checkpoint worker could not start/.test(l)).length, 1, logged.join('\n'))
      db.transaction(() => { insert.run(big) }).immediate()
      watchWal()
      assert.equal(checkpointAsked(), false)
    } finally { setCheckpointWorkerFileForTests(null) }
    watchWal()
    assert.equal(auto(), room, 'back at the room once the worker can start')
    assert.equal(process.env[WAL_WATCHED_ENV], process.env.DB_PATH)
  })

await ok('stopped: SQLite\'s own back at 2,000 here, the mark gone from the environment', async () => {
  stopWalWatch()
  assert.equal(auto(), DB_AUTO_CHECKPOINT_FRAMES)
  assert.equal(process.env[WAL_WATCHED_ENV], undefined)
  const theirs = await onAThread<number>(`send(db.pragma('wal_autocheckpoint', { simple: true }))`)
  assert.equal(theirs, DB_AUTO_CHECKPOINT_FRAMES)
})

await closeWalCheckpointer()
if (failures) { console.log(`${failures} wal-watch check(s) failed`); process.exitCode = 1 }
else console.log('All wal-watch checks passed.')

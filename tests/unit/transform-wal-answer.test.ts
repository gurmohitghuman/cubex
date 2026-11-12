// A transform_column call that finds the WAL past WAL_PAUSE_FRAMES while a checkpoint it didn't ask for is still
// on its way (lib/wal-checkpointer.ts): that checkpoint copied the WAL on the worker before the call read the WAL's
// size, and its answer waits for this thread. Its answer says nothing about frames written after it began, so the
// call can't take "copied nothing more" from it as a reader holding them: it asks for a checkpoint of its own and
// waits for it, and its first page begins with the WAL copied back (no page begins with WAL_PAUSE_FRAMES uncopied).
// Made without timing: a read held open on a second connection keeps SQLite from starting the WAL over while frames
// go in after that checkpoint copied, and ends before the call, so nothing holds them any more; this thread doesn't
// yield between the copy and the call's first wait, so the answer is still on its way, as when a page or a call's
// own start kept the thread busy. A read still held when the call comes is transform-wal-wait.test.ts's case.
// And a call whose first wait runs out of its time (a checkpoint slower than the call's 2 s) writes no page, even
// when the clock it reads (Date.now, a wall clock) says a little less time went by than the wait's timer (a steady
// clock) counted, as when the wall clock is being slewed: it answers updated 0 and the waited note.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import apiMod from '../../server/src/lib/api-v1-constants'
import constMod from '../../server/src/lib/constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import { sqliteWriteProbe } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn, TRANSFORM_WAITED_NOTE } =
  transformMod as typeof import('../../server/src/services/column-transform')
const { TRANSFORM_MAX_CALL_MS } = apiMod as typeof import('../../server/src/lib/api-v1-constants')
const { WAL_PAUSE_FRAMES } = constMod as typeof import('../../server/src/lib/constants')
const { checkpointInBackground, closeWalCheckpointer, setCheckpointDelayForTests, takeWalCheckpointerStats,
  walCheckpointerIdle, walState } = walMod as typeof import('../../server/src/lib/wal-checkpointer')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 12_000
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
const NOTES = 'n'.repeat(200)
function sheet(name: string, rows: number): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(id, tid, uid, name, JSON.stringify(['N', 'Notes']))
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(uuid(), id, uid, i, JSON.stringify({ N: `r${i}`, Notes: NOTES }))
  }).immediate()
  return id
}
// Each case its own sheet, so one failing leaves the other's as it was.
const big = sheet('Big', ROWS), small = sheet('Small', 1_000)
const probe = sqliteWriteProbe(db, process.env.DB_PATH!)
// Reads its own target: a row written twice would end with its suffix twice.
const call = (sheetId: string, cursor?: string) => transformColumn(uid, { sheetId, operation: 'template',
  template: '{{N}}x', targetColumn: 'N', ...(cursor === undefined ? {} : { cursor }) })
const once = (sheetId: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.N') = 'r' || row_index || 'x'`).pluck().get(sheetId) as number
async function finish(sheetId: string, cursor: string | undefined) {
  while (cursor) {
    const out = await call(sheetId, cursor)
    assert.ok('ok' in out, JSON.stringify(out))
    cursor = out.ok.next_cursor
  }
}

// Frames into the WAL, each statement its own transaction (not one the probe counts as a page): 500 rows' Notes
// rewritten at a time until the WAL holds `frames`.
const notes = db.prepare(`UPDATE rows SET data = json_set(data, '$.Notes', ?) WHERE sheet_id = ? AND row_index >= ?
  AND row_index < ?`)
let next = 0
function fill(frames: number): void {
  for (let n = 0; walState()!.log < frames; n++, next = (next + 500) % ROWS) {
    notes.run(`m${n}`.padEnd(200, 'm'), big, next, next + 500)
  }
}
const nap = new Int32Array(new SharedArrayBuffer(4))

async function main() {
  await check('a checkpoint that copied before the call read the WAL, its answer still on its way: the call waits '
    + 'for one of its own, and no page begins with the WAL past its bound uncopied', async () => {
    // The worker running, the WAL empty.
    await checkpointInBackground()
    await walCheckpointerIdle()
    probe.reset()
    takeWalCheckpointerStats()
    const reader = new Database(process.env.DB_PATH!)
    let held = true
    try {
      fill(WAL_PAUSE_FRAMES - 600)
      const copiedTo = walState()!.log
      // Reads at the WAL's end: the checkpoint can copy every frame, and the WAL can't start over while it reads.
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM rows').get()
      let answered = false
      void checkpointInBackground().then(() => { answered = true })
      // Synchronous from here to the call's first wait: the worker copies on its own thread, its answer waits.
      for (const until = Date.now() + 10_000; walState()!.checkpointed < copiedTo;) {
        assert.ok(Date.now() < until, 'the worker never copied the WAL')
        Atomics.wait(nap, 0, 0, 2)
      }
      fill(WAL_PAUSE_FRAMES)
      reader.exec('COMMIT')
      held = false
      const s = walState()!
      console.log('     ', JSON.stringify({ copiedTo, wal: s, answered }))
      assert.ok(!answered && s.checkpointed === copiedTo && s.log >= WAL_PAUSE_FRAMES, JSON.stringify(s))
      const out = await call(big)
      assert.ok('ok' in out && out.ok.updated > 0 && out.ok.next_cursor, JSON.stringify(out))
      const w = probe.read()
      const k = takeWalCheckpointerStats()
      console.log('     ', JSON.stringify({ updated: out.ok.updated, checkpoints: k.checkpoints, waits: k.pauses,
        mostBeforeWrite: w.mostWalFramesBeforeWrite, mostWalFrames: w.mostWalFrames }))
      assert.ok(k.checkpoints >= 2, `it waited for no checkpoint of its own: ${JSON.stringify(k)}`)
      assert.ok(w.mostWalFramesBeforeWrite < WAL_PAUSE_FRAMES,
        `a page began with ${w.mostWalFramesBeforeWrite} frames in the WAL, not all copied back`)
      await finish(big, out.ok.next_cursor)
      assert.equal(once(big), ROWS)
    } finally {
      if (held) reader.exec('COMMIT')
      reader.close()
    }
  })

  await check('a first wait that runs out of the call\'s time writes no page, even with the clock reading a little '
    + 'behind the wait\'s timer: the call answers updated 0 and the waited note', async () => {
    await walCheckpointerIdle()
    probe.reset()
    // Past its bound (frames from the other sheet), nothing copied: the call's first wait asks for a checkpoint that
    // takes longer than the call's time.
    fill(WAL_PAUSE_FRAMES)
    const realNow = Date.now
    const from = realNow()
    // A tenth slow: the margin keeps a timer that fires late on a busy machine still ahead of this clock.
    Date.now = () => from + Math.floor((realNow() - from) * 0.9)
    setCheckpointDelayForTests(TRANSFORM_MAX_CALL_MS + 500)
    let out: Awaited<ReturnType<typeof call>>
    try { out = await call(small) } finally { Date.now = realNow; setCheckpointDelayForTests(0) }
    console.log('     ', JSON.stringify(out))
    assert.ok('ok' in out && out.ok.next_cursor, JSON.stringify(out))
    // No page: not a row written (the pass's record, written at the call's end, is no page).
    assert.equal(once(small), 0, 'a page was written after the wait ran out of the call\'s time')
    assert.deepEqual(out, { ok: { updated: 0, created_column: null, next_cursor: out.ok.next_cursor,
      note: TRANSFORM_WAITED_NOTE } })
    await walCheckpointerIdle()
    await finish(small, out.ok.next_cursor)
    assert.equal(once(small), 1_000)
  })
  await closeWalCheckpointer()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-wal-answer assertions passed.')
    process.exit(0)
  })

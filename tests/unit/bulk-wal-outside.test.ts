// A writer outside the background bulk writers' runner (lib/bulk-slices.ts), on the API connection all through a
// job that rewrites rows with random ids slice after slice (the fixture of bulk-wal-runner.test.ts): the WAL passes
// the job's room only while the worker may be copying it back, and journal_size_limit only by what came then.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import constMod from '../../server/src/lib/constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import bulkMod from '../../server/src/lib/bulk-slices'
import { bulkWalKit } from './bulk-wal-kit'
import { transactionLine, type TransactionRecord } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { DB_AUTO_CHECKPOINT_FRAMES, WAL_BULK_ROOM_SHARE } = constMod as typeof import('../../server/src/lib/constants')
const { checkpointAnswer, checkpointInBackground, closeWalCheckpointer, setCheckpointDelayForTests,
  walCheckpointerIdle } = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { autoCheckpointHolders, runInCheckpointedSlices } = bulkMod as typeof import('../../server/src/lib/bulk-slices')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const quiet = console.error
console.error = (...a: unknown[]) => { if (!/checkpoint/i.test(String(a[0]))) quiet(...a) }
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const { probe } = bulkWalKit()
const auto = () => db.pragma('wal_autocheckpoint', { simple: true }) as number
const page = db.pragma('page_size', { simple: true }) as number
const sizeLimit = db.pragma('journal_size_limit', { simple: true }) as number
// The frames a job may take the WAL to with journal_size_limit at `limit`: SQLite's own checkpoint waits for it.
const roomFor = (limit: number) => Math.floor((WAL_BULK_ROOM_SHARE * limit) / (page + 24))

// 20,000 rows with random ids and about 300 bytes each: a slice of 500 rewrites pages all over the table.
const ROWS = 20_000, SLICE = 500
// Commits outside the runner (about twice journal_size_limit's frames), how long the worker's checkpoints are held
// meanwhile (longer than those commits take), and the part of that hold not counted on (timers run late).
const OUTSIDE_COMMITS = 400, OUTSIDE_DELAY_MS = 3_000, FREE_MARGIN_MS = 100
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
const count = (v: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.N') = ?`).pluck().get(sid, v) as number
const back = () => {
  assert.equal(auto(), DB_AUTO_CHECKPOINT_FRAMES, 'SQLite\'s own checkpoint is back on')
  assert.equal(autoCheckpointHolders(), 0)
}

// A writer outside the runner (an import, say) on the API connection all through a job: 1,000 rows of 300 bytes
// rewritten a commit (about 80 frames), a turn between. Past the job's room its commits run SQLite's own
// checkpoint, as with no job, and the WAL starts over. With SQLite's own checkpoint off, the worker never copied
// every frame (more kept coming), so the WAL never started over: it grew as long as both went on. But while the
// worker copies the WAL back it holds SQLite's checkpoint lock, so such a commit's own checkpoint copies nothing
// (the next one tries again): on a slow disk the WAL passes the room by what that writer commits until the copy
// ends. So: every commit past the room made while the worker surely wasn't copying copies every frame back itself,
// and the WAL passes journal_size_limit only by frames added past the room while it may have been. The worker's
// checkpoints are held OUTSIDE_DELAY_MS first, and it copies nothing meanwhile: a commit is sure to come while it
// isn't copying if none was asked, or if it ended before the hold of the one asked could (asked after the look
// before, so its hold ends no sooner than that look and OUTSIDE_DELAY_MS, less a margin for timers). The job goes
// on, the rows rewritten again from the first, until that writer has made OUTSIDE_COMMITS: counted, not timed.
// That writer gets 2 commits between two slices and the rest while the job waits for a held checkpoint, so on a
// slow disk (commits of 60 ms) a job of one pass ended before them.
await ok('a writer outside the runner all through a job: past the room only while the worker may be copying',
  async () => {
  db.exec('CREATE TABLE outside_writes (id INTEGER PRIMARY KEY, v TEXT)')
  const fill = db.prepare('INSERT INTO outside_writes (v) VALUES (?)')
  db.transaction(() => { for (let i = 0; i < 1_000; i++) fill.run('o'.repeat(300)) }).immediate()
  const touch = db.prepare('UPDATE outside_writes SET v = ?')
  await checkpointInBackground()
  await walCheckpointerIdle()
  probe.reset()
  setCheckpointDelayForTests(OUTSIDE_DELAY_MS)
  let done = false, commits = 0, slices = 0
  const outside: Array<{ r: TransactionRecord; free: boolean }> = []
  let seen: unknown = null, looked = performance.now(), askedAfter = looked
  try {
    const step = () => {
      const at = (slices++ * SLICE) % ROWS
      set.run('n', JSON.stringify(rowids.slice(at, at + SLICE)))
      return slices * SLICE < ROWS || commits < OUTSIDE_COMMITS
    }
    const job = runInCheckpointedSlices(step).finally(() => { done = true })
    while (!done && commits < OUTSIDE_COMMITS) {
      const now = performance.now()
      const asked = checkpointAnswer()
      if (asked !== seen) { seen = asked; askedAfter = looked }
      looked = now
      db.transaction(() => { touch.run(String(commits++).padEnd(300, 'o')) }).immediate()
      const free = asked === null || performance.now() < askedAfter + OUTSIDE_DELAY_MS - FREE_MARGIN_MS
      outside.push({ r: probe.records().at(-1)!, free })
      await new Promise(r => setImmediate(r))
    }
    await job
  } finally { setCheckpointDelayForTests(0) }
  const w = probe.read()
  const room = roomFor(sizeLimit), limit = Math.floor(sizeLimit / (page + 24))
  const free = new Set(outside.filter(o => o.free).map(o => o.r))
  const past = outside.filter(o => o.r.after.log >= room)
  const kept = past.filter(o => o.free && o.r.after.checkpointed < o.r.after.log)
  // Frames added past the room while the worker may have been copying: by that writer's other commits, and by
  // slices begun with a checkpoint asked.
  const unsure = probe.records().filter(r => !free.has(r) && (r.checkpointing || outside.some(o => o.r === r)))
  const unsureFrames = unsure.reduce((n, r) => n + Math.max(0, r.after.log - Math.max(r.before.log, room)), 0)
  console.log(`      outside: ${commits} commits during ${slices} slices of the job, WAL peak ${w.mostWalFrames} `
    + `frames (${32 + w.mostWalFrames * (page + 24)} bytes of ${sizeLimit}); past the room (${room} frames): `
    + `${past.filter(o => o.free).length} commits with the worker not copying, ${past.filter(o => !o.free).length} `
    + `while it may have been, ${unsureFrames} frames added past it then`)
  assert.equal(count('n'), ROWS)
  back()
  assert.ok(commits * 80 > room, `only ${commits} commits outside the runner`)
  assert.deepEqual(kept.map(o => transactionLine(o.r)), [],
    'commits past the room, the worker not copying, that left frames uncopied')
  assert.ok(w.mostWalFrames - unsureFrames < limit, `the WAL peaked at ${w.mostWalFrames} frames, past `
    + `journal_size_limit (${limit}) by more than the ${unsureFrames} added past the room while the worker may have `
    + 'been copying')
})

await closeWalCheckpointer()
if (failures > 0) { console.error(`${failures} bulk-wal-outside assertion(s) failed`); process.exit(1) }
console.log('All bulk-wal-outside assertions passed.')
process.exit(0)

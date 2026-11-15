// A read on the API connection while the checkpoint worker copies a big WAL back and syncs the database file
// (lib/wal-checkpointer.ts). Another connection commits before each read, so each read finds the WAL changed by
// another connection: SQLite drops what it had mapped of the database file and, with memory-mapped reads on, maps
// the file again, asking its size first. On Windows that waited for the worker's sync of the file (a read held the
// server's thread 1.7 s on the Windows runner), so lib/db.ts maps nothing there. Run twice: with the mapping on (as
// Linux has it; printed only, to show whether this machine waits), then with the server's own setting, whose
// longest read must stay under LOOP_LIMIT_MS. A watcher thread (stall-watch.ts) prints when the copy started and
// ended and whether its own size queries on the file waited meanwhile, so a run whose sync never waited shows as one.
// First, opening the worker's connection analyzes no table (lib/db.ts skips PRAGMA optimize there): on a table that
// a new connection's optimize analyzes (an index, 2,000 rows, never analyzed), no sqlite_stat1 line comes.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import walMod from '../../server/src/lib/wal-checkpointer'
import slicesMod from '../../server/src/lib/slices'
import { LOOP_LIMIT_MS } from './bulk-wal-kit'
import { stallWatch } from './stall-watch'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { checkpointInBackground, closeWalCheckpointer } =
  walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { withoutAutoCheckpoint } = slicesMod as typeof import('../../server/src/lib/slices')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const dbPath = process.env.DB_PATH
runMigrations()
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

// The server's own setting, and Linux's.
const OWN = db.pragma('mmap_size', { simple: true }) as number
const MAPPED = 268_435_456
// Rows of 3,000 random bytes written before each copy, about one page each: some 47 MB of WAL (under
// journal_size_limit) for the worker to copy back, a sync of seconds on the Windows runner.
const ROWS = 12_000

db.exec(`CREATE TABLE reads_cold (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE reads_big (b BLOB);
  CREATE TABLE reads_other (id INTEGER PRIMARY KEY); CREATE TABLE unanalyzed (id INTEGER PRIMARY KEY, v TEXT);
  CREATE INDEX unanalyzed_v ON unanalyzed (v)`)
db.prepare('INSERT INTO reads_cold (v) VALUES (?)').run('cold')
const addOne = db.prepare('INSERT INTO unanalyzed (v) VALUES (?)')
db.transaction(() => { for (let i = 0; i < 2_000; i++) addOne.run(`v${i % 97}`) }).immediate()
const analyzed = () => db.prepare("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'sqlite_stat1'").pluck().get()
  ? db.prepare("SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = 'unanalyzed'").pluck().get() as number : 0

await ok('opening the worker\'s connection analyzes no table', async () => {
  assert.equal(analyzed(), 0, 'analyzed before the worker started')
  // The worker starts here. The cold row's page goes into the database file, read from there from now on, and the
  // WAL starts over.
  const r = await checkpointInBackground()
  assert.ok(r && r.startOver === 'done', JSON.stringify(r))
  assert.equal(analyzed(), 0, 'the worker\'s connection analyzed the table')
})
const other = new Database(dbPath)
other.pragma('busy_timeout = 5000')
// Its commits never copy the WAL back themselves: the worker does.
other.pragma('wal_autocheckpoint = 0')
const touch = other.prepare('INSERT INTO reads_other DEFAULT VALUES')
const read = db.prepare('SELECT v FROM reads_cold WHERE id = 1').pluck()
const fill = db.prepare('INSERT INTO reads_big (b) VALUES (randomblob(3000))')

// The longest read on the API connection, `mmap` bytes mapped, while the worker copies ROWS rows' pages back.
async function readsDuringCopy(mmap: number): Promise<number> {
  db.pragma(`mmap_size = ${mmap}`)
  try {
    // The watcher first: it is reading by the time the copy starts.
    const watch = stallWatch(db, dbPath)
    withoutAutoCheckpoint(() => db.transaction(() => { for (let i = 0; i < ROWS; i++) fill.run() }).immediate())
    const p0 = performance.now()
    let done = false
    const copy = checkpointInBackground().finally(() => { done = true })
    let longest = { at: 0, ms: 0 }, longestTouch = 0, reads = 0
    while (!done) {
      const t = performance.now()
      touch.run()
      const at = performance.now()
      longestTouch = Math.max(longestTouch, at - t)
      assert.equal(read.get(), 'cold')
      if (performance.now() - at > longest.ms) longest = { at, ms: performance.now() - at }
      reads++
      await new Promise(r => setTimeout(r, 2))
    }
    const r = await copy
    const took = performance.now() - p0
    // The watcher reads on a little: the copy's end may come just after its last read.
    await new Promise(res => setTimeout(res, 10))
    const seen = await watch(p0)
    console.log(`      mmap_size ${mmap}: ${reads} reads while the worker copied ${r?.checkpointed ?? 'no'} frames `
      + `back in ${took.toFixed(0)} ms; the longest ${longest.ms.toFixed(0)} ms at ${(longest.at - p0).toFixed(0)}, `
      + `the other connection's longest commit ${longestTouch.toFixed(0)} ms\n        ${seen}`)
    assert.ok(r && r.checkpointed >= ROWS, `the worker copied ${r?.checkpointed} frames back`)
    // Nothing left for the next run's copy: the WAL started over.
    await checkpointInBackground()
    return longest.ms
  } finally {
    db.pragma(`mmap_size = ${OWN}`)
  }
}

await ok('reads while the worker copies a big WAL back: mapped, then as the server reads', async () => {
  await readsDuringCopy(MAPPED)
  assert.equal(OWN, process.platform === 'win32' ? 0 : MAPPED, 'the server maps the database file on Linux only')
  const ms = await readsDuringCopy(OWN)
  assert.ok(ms < LOOP_LIMIT_MS, `a read took ${ms.toFixed(0)} ms while the worker copied the WAL back`)
})

other.close()
await closeWalCheckpointer()
if (failures > 0) { console.error(`${failures} wal-worker-reads assertion(s) failed`); process.exit(1) }
console.log('All wal-worker-reads assertions passed.')
process.exit(0)

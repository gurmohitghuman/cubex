// A CSV import's flush (services/csv-import.ts), a clean column's fill and follow (services/derived-write.ts) and
// a column added from an answer (services/answer-field-fill.ts) each stop a slice once it has taken BULK_SLICE_MS
// (lib/slice-clock.ts), so a slow machine or a busy CPU gets smaller slices, not longer ones. Each case gives the
// slices a clock that moves a set time each time it's read (at a slice's start, then once for each row after its
// first), so the slices are the same on every machine. At 1 ms a read, 1,000 rows go in 25 slices or more, none
// writing more than BULK_SLICE_MS rows, every row once and in order. At 50 ms a read (past the limit at each row),
// every slice still writes one row, so the job always moves on. A slice is one transaction (lib/bulk-slices.ts):
// each row written is counted with the transaction it was written in.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const { setSliceClockForTests } = await import('../../server/src/lib/slice-clock')
const { BULK_SLICE_MS } = await import('../../server/src/lib/constants')
const { importCsv } = await import('../../server/src/services/csv-import')
const { scanCsvText } = await import('../../server/src/lib/csv-import-parse')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { waitForCleanFill } = await import('../../server/src/services/clean-fill')
const { cleanFollowTick } = await import('../../server/src/services/clean-follow')
const { markAutorunInputs } = await import('../../server/src/lib/autorun-mark')
const { entryFor } = await import('../../server/src/services/autorun-entry')
const { runFieldJob } = await import('../../server/src/services/answer-field-fill')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let failures = 0
const ok = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const sheet = (rows: Array<Record<string, unknown>>, columns: string[]) => {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(columns))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => rows.forEach((r, i) => ins.run(uuid(), sid, uid, i, JSON.stringify(r)))).immediate()
  return sid
}
const cells = (sid: string, column: string) => db.prepare(`SELECT json_extract(data, ?) FROM rows
  WHERE sheet_id = ? ORDER BY row_index`).pluck().all(`$."${column}"`, sid) as unknown[]

// Each transaction counted as it starts: the app makes them at run time, so db.transaction is wrapped here (as
// sqlite-write-probe.ts does). Every row added or written is kept with the transaction it was in.
let tx = 0
const realTransaction = db.transaction
db.transaction = ((fn: (...a: unknown[]) => unknown) => {
  const t = realTransaction.call(db, fn) as unknown as Record<string, (...a: unknown[]) => unknown>
  const counted = (call: (...a: unknown[]) => unknown) => (...a: unknown[]) => { tx++; return call(...a) }
  const w = counted(t as unknown as (...a: unknown[]) => unknown) as unknown as Record<string, unknown>
  for (const k of ['default', 'deferred', 'immediate', 'exclusive']) w[k] = counted(t[k])
  return w
}) as unknown as typeof db.transaction
db.function('slice_tx', { deterministic: false }, () => tx)
db.exec(`CREATE TEMP TABLE written (tx INTEGER, sheet TEXT, i INTEGER);
  CREATE TEMP TRIGGER row_added AFTER INSERT ON rows
  BEGIN INSERT INTO written VALUES (slice_tx(), NEW.sheet_id, NEW.row_index); END;
  CREATE TEMP TRIGGER row_written AFTER UPDATE OF data ON rows
  BEGIN INSERT INTO written VALUES (slice_tx(), NEW.sheet_id, NEW.row_index); END`)

// `job` run with a clock moving `ms` each read: the rows of `sid` it wrote, in the order it wrote them, and how
// many each of its transactions wrote.
async function sliced(sid: string, ms: number, job: () => Promise<void>) {
  db.exec('DELETE FROM written')
  let t = 0
  setSliceClockForTests(() => (t += ms))
  try { await job() } finally { setSliceClockForTests(null) }
  const rows = db.prepare('SELECT i FROM written WHERE sheet = ? ORDER BY rowid').pluck().all(sid) as number[]
  const slices = db.prepare('SELECT COUNT(*) FROM written WHERE sheet = ? GROUP BY tx ORDER BY tx').pluck()
    .all(sid) as number[]
  return { rows, slices }
}
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i)
// At 1 ms a read: every row once and in order, in 25 slices or more of at most BULK_SLICE_MS rows.
function timed(got: { rows: number[]; slices: number[] }, n: number) {
  assert.deepEqual(got.rows, upTo(n), 'every row once and in order')
  assert.ok(got.slices.length >= n / BULK_SLICE_MS, `${got.slices.length} slices: ${got.slices.join(', ')}`)
  assert.ok(got.slices.every(k => k >= 1 && k <= BULK_SLICE_MS), `rows a slice: ${got.slices.join(', ')}`)
}
// At 50 ms a read: one row a slice.
function slow(got: { rows: number[]; slices: number[] }, n: number) {
  assert.deepEqual(got.rows, upTo(n), 'every row once and in order')
  assert.deepEqual(got.slices, upTo(n).map(() => 1))
}

async function imported(n: number, ms: number) {
  const sid = sheet([], ['Name'])
  const scanned = await scanCsvText(`Name\n${upTo(n).map(i => `n${i}`).join('\n')}\n`)
  const got = await sliced(sid, ms, async () => {
    const out = await importCsv(sid, uid, scanned, false)
    assert.ok('ok' in out, JSON.stringify(out))
  })
  assert.deepEqual(cells(sid, 'Name'), upTo(n).map(i => `n${i}`))
  return got
}
await ok('an import at 1 ms a read: 1,000 rows in slices of at most BULK_SLICE_MS rows', async () => {
  timed(await imported(1_000, 1), 1_000)
})
await ok('an import at 50 ms a read: one row a slice', async () => { slow(await imported(30, 50), 30) })

async function cleaned(n: number, ms: number) {
  const sid = sheet(upTo(n).map(i => ({ Name: `  n${i}  ` })), ['Name'])
  const got = await sliced(sid, ms, async () => {
    const started = await startCleanColumn(uid, sid, { source: 'Name', cleaner: 'trim' })
    assert.ok('ok' in started, JSON.stringify(started))
    const filled = await waitForCleanFill(started.ok.id, 60_000)
    assert.equal(filled?.fill_status, 'done', JSON.stringify(filled))
  })
  assert.deepEqual(cells(sid, 'Name (clean)'), upTo(n).map(i => `n${i}`))
  return { sid, got }
}
await ok('a clean column\'s fill at 1 ms a read: 1,000 rows in slices of at most BULK_SLICE_MS rows', async () => {
  timed((await cleaned(1_000, 1)).got, 1_000)
})
await ok('a clean column\'s fill at 50 ms a read: one row a slice', async () => {
  slow((await cleaned(30, 50)).got, 30)
})

await ok('a clean column following its source at 1 ms a read: slices of at most BULK_SLICE_MS rows', async () => {
  const { sid } = await cleaned(1_000, 0)
  db.transaction(() => {
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Name', ' m' || row_index || ' ') WHERE sheet_id = ?`)
      .run(sid)
    markAutorunInputs(sid, uid, ['Name'], { indexes: upTo(1_000) })
  }).immediate()
  const queued = db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?').pluck()
  const id = entryFor(sid, uid, 'Name (clean)')!.id
  const got = await sliced(sid, 1, async () => {
    for (const end = Date.now() + 60_000; (queued.get(id) as number) > 0 && Date.now() < end;) {
      await cleanFollowTick(entryFor(sid, uid, 'Name (clean)')!)
    }
  })
  assert.equal(queued.get(id), 0, 'the queue is empty')
  assert.deepEqual(cells(sid, 'Name (clean)'), upTo(1_000).map(i => `m${i}`))
  assert.deepEqual([...got.rows].sort((a, b) => a - b), upTo(1_000), 'every row once')
  assert.ok(got.slices.every(k => k >= 1 && k <= BULK_SLICE_MS), `rows a slice: ${got.slices.join(', ')}`)
})

await ok('a clean column following 1,000 new rows at 1 ms a read: slices of at most BULK_SLICE_MS rows', async () => {
  const { sid } = await cleaned(10, 0)
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => upTo(1_000).forEach(i => ins.run(uuid(), sid, uid, 10 + i,
    JSON.stringify({ Name: `  n${10 + i}  ` })))).immediate()
  const entry = () => entryFor(sid, uid, 'Name (clean)')!
  const got = await sliced(sid, 1, async () => {
    for (const end = Date.now() + 60_000; entry().watermark_row_index < 1_009 && Date.now() < end;) {
      await cleanFollowTick(entry())
    }
  })
  assert.deepEqual(cells(sid, 'Name (clean)'), upTo(1_010).map(i => `n${i}`))
  assert.deepEqual(got.rows, upTo(1_000).map(i => 10 + i), 'every new row once and in order')
  assert.ok(got.slices.length >= 1_000 / BULK_SLICE_MS, `${got.slices.length} slices: ${got.slices.join(', ')}`)
  assert.ok(got.slices.every(k => k >= 1 && k <= BULK_SLICE_MS), `rows a slice: ${got.slices.join(', ')}`)
})

async function answered(n: number, ms: number) {
  const sid = sheet(upTo(n).map(i => ({ Name: `n${i}` })), ['Name', 'Email'])
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name)
    VALUES (?,?,?,?, 'completed', 'Email')`).run(run, sid, uid,
    JSON.stringify({ responseMapping: [], enrichment: { kind: 'waterfall', email: null } }))
  const ins = db.prepare(`INSERT INTO http_results (id, run_id, user_id, row_index, response_data, status)
    VALUES (?,?,?,?,?, 'completed')`)
  db.transaction(() => upTo(n).forEach(i => ins.run(uuid(), run, uid, i,
    JSON.stringify({ output: { title: `t${i}` }, _treg: { outcome: 'hit' }, $fill: 'all' })))).immediate()
  const job = uuid()
  db.prepare(`INSERT INTO enrichment_field_jobs (id, user_id, sheet_id, status_column, column_name, json_path)
    VALUES (?,?,?, 'Email', 'Title', '$.output.title')`).run(job, uid, sid)
  const got = await sliced(sid, ms, () => runFieldJob(job))
  assert.equal(db.prepare('SELECT status FROM enrichment_field_jobs WHERE id = ?').pluck().get(job), 'done')
  assert.deepEqual(cells(sid, 'Title'), upTo(n).map(i => `t${i}`))
  return got
}
await ok('a column added from an answer at 1 ms a read: 1,000 rows in slices of at most BULK_SLICE_MS rows',
  async () => { timed(await answered(1_000, 1), 1_000) })
await ok('a column added from an answer at 50 ms a read: one row a slice', async () => {
  slow(await answered(30, 50), 30)
})

db.transaction = realTransaction
await closeWalCheckpointer()
if (failures) { console.log(`${failures} bulk-slice-time assertion(s) failed`); process.exit(1) }
console.log('All bulk-slice-time assertions passed.')

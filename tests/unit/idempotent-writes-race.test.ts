// Two calls with one idempotency key at the same moment, each on its own
// thread and its own database connection (as two server processes, or two
// requests the server took at once, would be): the rows are written once and
// the other call replays the first answer (services/rows-write-keyed.ts). To
// make the overlap certain, this thread holds the write lock while both calls
// start, so both are waiting when it lets go.
import assert from 'node:assert/strict'
import { Worker } from 'worker_threads'
import { createRequire } from 'module'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const requireHere = createRequire(import.meta.url)
const uid = uuid(), tid = uuid(), sheet = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sheet, tid, uid, 'S', JSON.stringify(['Name', 'Email']))

// A thread that loads the service, says it's ready, waits for the go and makes one call.
const code = `require(${JSON.stringify(requireHere.resolve('tsx/cjs/api'))}).register();
  const { parentPort, workerData } = require('worker_threads');
  const keyed = require(${JSON.stringify(requireHere.resolve('../../server/src/services/rows-write-keyed'))});
  parentPort.postMessage('ready');
  Atomics.wait(new Int32Array(workerData.go), 0, 0);
  let out;
  try { out = keyed[workerData.fn](...workerData.args); } catch (e) { out = { threw: String(e && e.message) }; }
  parentPort.postMessage(JSON.stringify(out));`

function thread(go: SharedArrayBuffer, fn: string, args: unknown[]) {
  const w = new Worker(code, { eval: true, workerData: { go, fn, args } })
  let ready!: () => void
  const isReady = new Promise<void>(r => { ready = r })
  const answer = new Promise<any>((resolve, reject) => {
    w.on('message', m => (m === 'ready' ? ready() : resolve(JSON.parse(m))))
    w.on('error', reject)
    w.on('exit', c => (c === 0 ? null : reject(new Error(`thread exited ${c}`))))
  })
  return { isReady, answer: answer.finally(() => w.terminate()) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function race(fn: string, args: unknown[]): Promise<any[]> {
  const go = new SharedArrayBuffer(4)
  const threads = [thread(go, fn, args), thread(go, fn, args)]
  await Promise.all(threads.map(t => t.isReady))
  db.exec('BEGIN IMMEDIATE')
  Atomics.store(new Int32Array(go), 0, 1)
  Atomics.notify(new Int32Array(go), 0)
  await sleep(400)  // both are now waiting for the lock this thread holds
  db.exec('COMMIT')
  return Promise.all(threads.map(t => t.answer))
}

let failures = 0
async function check(label: string, fn: () => Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const count = () => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sheet) as number
const entries = (key: string) =>
  db.prepare('SELECT count(*) FROM data_operation_ledger WHERE idempotency_key = ?').pluck().get(key) as number

async function main() {
  await check('two appends with one key at once: written once, the other replays the same rows', async () => {
    const rows = [{ Name: 'Ann' }, { Name: 'Bo' }, { Name: 'Cy' }]
    const [a, b] = await race('appendRowsKeyed', [sheet, uid, rows, 'race-append', 'mcp'])
    assert.ok(!a.threw && !b.threw && !a.fail && !b.fail, JSON.stringify([a, b]))
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true])
    assert.deepEqual(a.ok.answer.rows, b.ok.answer.rows)
    assert.equal(count(), 3)
    assert.equal(entries('race-append'), 1)
  })

  await check('two many-row updates with one key at once: written once, the other replays', async () => {
    const ids = db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheet) as string[]
    const updates = ids.map(id => ({ rowId: id, cells: { Email: `${id}@x.io` } }))
    const version = () => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(sheet) as number
    const before = version()
    const [a, b] = await race('batchUpdateKeyed', [sheet, uid, updates, 'race-update', 'mcp'])
    assert.ok(!a.threw && !b.threw && !a.fail && !b.fail, JSON.stringify([a, b]))
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true])
    assert.equal(version(), before + 1, 'one write bumped the sheet once')
    assert.equal(entries('race-update'), 1)
  })

  await check('the same key with other rows at once: one writes, the other is refused', async () => {
    const go = new SharedArrayBuffer(4)
    const threads = [
      thread(go, 'appendRowsKeyed', [sheet, uid, [{ Name: 'one' }], 'race-mixed', 'mcp']),
      thread(go, 'appendRowsKeyed', [sheet, uid, [{ Name: 'two' }], 'race-mixed', 'mcp']),
    ]
    await Promise.all(threads.map(t => t.isReady))
    const before = count()
    db.exec('BEGIN IMMEDIATE')
    Atomics.store(new Int32Array(go), 0, 1)
    Atomics.notify(new Int32Array(go), 0)
    await sleep(400)
    db.exec('COMMIT')
    const out = await Promise.all(threads.map(t => t.answer))
    assert.equal(out.filter(o => o.fail === 'idempotency_conflict').length, 1, JSON.stringify(out))
    assert.equal(out.filter(o => o.replayed === false).length, 1, JSON.stringify(out))
    assert.equal(count(), before + 1)
  })
}

main()
  .catch(err => { failures++; console.log('FAIL threw', err) })
  .finally(() => {
    db.close()
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('\nall idempotent write race checks passed')
  })

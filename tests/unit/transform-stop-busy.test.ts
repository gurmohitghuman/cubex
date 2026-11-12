// transform_column stopped on an error, further cases
// (services/column-transform.ts, column-transform-passes.ts). Another
// connection takes the write lock after the first page and holds it past
// busy_timeout: the second page fails with SQLITE_BUSY, the call answers
// next_cursor and rows_done in words naming it, data_version moves once the
// lock is let go (tried again on a timer, never waiting on the event loop), and
// going on with the cursor changes every row once. A sort
// marks the record: the same call is refused, without its cursor or with it,
// writing nothing, until restart: true starts over. When the data_version
// write itself meets the lock (held for seconds), it never waits on the event
// loop: it is tried again on a timer and moves once the lock is let go, with no
// other call, the loop never held 200 ms meanwhile.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import sortMod from '../../server/src/services/sheet-sort'
import { transformPageFault } from './transform-page-fault'
import { moved } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const requireHere = createRequire(import.meta.url)
const fault = transformPageFault(db)

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 1000
const uid = uuid(), tid = uuid(), busy = uuid(), sorted = uuid(), late = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
// late: one page, so its call ends after it.
for (const [n, id] of [busy, sorted, late].entries()) {
  addSheet.run(id, tid, uid, `S${n}`, n, JSON.stringify(['T']))
  db.transaction(() => {
    for (let i = 0; i < (id === late ? 100 : ROWS); i++) insert.run(uuid(), id, uid, i, JSON.stringify({ T: `t${i}` }))
  })()
}
const again = (sheetId: string) => ({ sheetId, operation: 'template' as const, template: '{{T}}-x', targetColumn: 'T' })
const dataVersion = (id: string) => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(id) as number
const suffixed = (id: string, glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.T') GLOB ?`).pluck().get(id, glob) as number
const records = (id: string) => db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(id)
// data_version past `before` within 5 s.
async function movedFrom(id: string, before: number) {
  for (const until = Date.now() + 5000; dataVersion(id) === before && Date.now() < until;) {
    await new Promise(r => setTimeout(r, 50))
  }
  return dataVersion(id) > before
}
const stoppedOn = async (id: string) => {
  fault.arm(251)
  try { return await transformColumn(uid, again(id)) } finally { fault.disarm() }
}

// Another connection, in a thread of its own: once told (flag 0), it takes the write lock, says so (flag 1) and
// holds it holdMs, past the app connection's busy_timeout (5,000 ms, lib/db.ts), then lets it go.
function lockHolder(holdMs = 6500) {
  const flags = new Int32Array(new SharedArrayBuffer(8))
  const worker = new Worker(`const { workerData } = require('node:worker_threads');
    const Database = require(workerData.sqlite);
    const f = new Int32Array(workerData.flags.buffer);
    Atomics.wait(f, 0, 0);
    const db = new Database(workerData.dbPath);
    db.exec('BEGIN IMMEDIATE');
    Atomics.store(f, 1, 1); Atomics.notify(f, 1);
    Atomics.wait(f, 0, 1, workerData.holdMs);
    db.exec('ROLLBACK'); db.close();`, { eval: true, workerData: { flags, holdMs,
    sqlite: requireHere.resolve('better-sqlite3'), dbPath: process.env.DB_PATH } })
  const exited = new Promise((resolve, reject) => { worker.on('exit', resolve); worker.on('error', reject) })
  return { exited, lockNow() {
    Atomics.store(flags, 0, 1); Atomics.notify(flags, 0)
    assert.equal(Atomics.wait(flags, 1, 0, 3000), 'ok', 'the other connection took the lock')
  } }
}
// The lock is taken where the call first reads the WAL's size (or checkpoints) once its first page wrote a row.
async function lockedAfterFirstPage(holder: ReturnType<typeof lockHolder>, id: string) {
  const [pragma, prepare] = [db.pragma, db.prepare]
  let armed = true, wrote = false
  db.prepare = ((sql: string) => {
    const stmt = prepare.call(db, sql)
    if (!sql.startsWith('UPDATE rows SET data = json_set(data, ?, ?)')) return stmt
    const run = stmt.run.bind(stmt)
    return Object.assign(stmt, { run: (...a: unknown[]) => { wrote = true; return run(...a) } })
  }) as typeof db.prepare
  db.pragma = ((src: string, opts?: object) => {
    if (armed && wrote && src.startsWith('wal_checkpoint')) { armed = false; holder.lockNow() }
    return pragma.call(db, src, opts)
  }) as typeof db.pragma
  try { return await transformColumn(uid, again(id)) } finally { db.pragma = pragma; db.prepare = prepare }
}

async function main() {
  await check('a second page that waits out busy_timeout on another connection\'s lock: next_cursor and '
    + 'rows_done, in words naming SQLITE_BUSY; data_version moved; going on changes every row once', async () => {
    const holder = lockHolder()
    const before = dataVersion(busy)
    const t0 = Date.now()
    const out = await lockedAfterFirstPage(holder, busy)
    console.log(`      answered after ${Date.now() - t0} ms`)
    await holder.exited
    assert.ok('stopped' in out, JSON.stringify(out))
    const cursor = out.stopped.next_cursor
    assert.deepEqual(out.stopped, { error: 'Stopped on an error after 250 rows: the sheet was busy (SQLITE_BUSY). '
      + `Those rows are written. Call transform_column again with the same arguments and cursor set to "${cursor}" `
      + 'to go on. Don\'t start over without cursor: that would apply the operation to those rows again.',
    next_cursor: cursor, rows_done: 250 })
    assert.ok(await movedFrom(busy, before), 'data_version moved')
    assert.equal(suffixed(busy, 't*-x'), 250)
    assert.ok('unfinished' in await transformColumn(uid, again(busy)))
    assert.deepEqual(await transformColumn(uid, { ...again(busy), cursor }),
      { ok: { updated: ROWS - 250, created_column: null } })
    assert.equal(suffixed(busy, 't*-x'), ROWS)
    assert.equal(suffixed(busy, '*-x-x'), 0)
  })

  await check('a sort marks the record: the call is refused without its cursor and with it, writing nothing; '
    + 'restart: true runs', async () => {
    const out = await stoppedOn(sorted)
    assert.ok('stopped' in out, JSON.stringify(out))
    assert.ok('unfinished' in await transformColumn(uid, again(sorted)))
    assert.ok('ok' in await physicalSortSheet(sorted, uid, 'T', 'desc'))
    assert.equal(records(sorted), 1, 'kept, marked')
    assert.deepEqual(await transformColumn(uid, again(sorted)), moved('T', 250))
    assert.deepEqual(await transformColumn(uid, { ...again(sorted), cursor: out.stopped.next_cursor }),
      moved('T', 250))
    assert.equal(suffixed(sorted, 't*-x'), 250, 'nothing written')
    assert.deepEqual(await transformColumn(uid, { ...again(sorted), restart: true }),
      { ok: { updated: ROWS, created_column: null } })
    assert.equal(records(sorted), 0)
  })

  await check('the data_version write meeting a lock held for seconds never holds the event loop: it is tried '
    + 'again, and moves once the lock is let go', async () => {
    // The call's one page commits, then the other connection takes the lock and holds it 3 s.
    const holder = lockHolder(3000)
    const before = dataVersion(late)
    let lastTick = Date.now(), loopMax = 0
    const sampler = setInterval(() => {
      const now = Date.now()
      loopMax = Math.max(loopMax, now - lastTick)
      lastTick = now
    }, 5)
    try {
      const out = await lockedAfterFirstPage(holder, late)
      assert.deepEqual(out, { ok: { updated: 100, created_column: null } })
      assert.equal(dataVersion(late), before, 'not yet: the lock is still held')
      await holder.exited
      assert.ok(await movedFrom(late, before), 'data_version moved once the lock was let go')
    } finally { clearInterval(sampler) }
    console.log(`      the event loop was held at most ${loopMax} ms`)
    assert.ok(loopMax < 200, `the event loop was held ${loopMax} ms`)
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-stop-busy assertions passed.')
    process.exit(0)
  })

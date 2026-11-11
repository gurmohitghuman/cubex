// transform_column stopped on an error, further cases
// (services/column-transform.ts, column-transform-passes.ts). Another
// connection takes the write lock after the first page and holds it past
// busy_timeout: the second page fails with SQLITE_BUSY, the call answers
// next_cursor and rows_done in words naming it, data_version moves once the
// lock is let go, and going on with the cursor changes every row once. After a
// sort, the record no longer holds (its cursor is refused too), so the same
// call without cursor starts over instead of being refused for good. The
// record goes with its sheet, deleted for good from the trash.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import sortMod from '../../server/src/services/sheet-sort'
import trashMod from '../../server/src/services/trash-sheets'
import purgeMod from '../../server/src/services/trash-purge'
import { transformPageFault } from './transform-page-fault'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
const { trashSheet } = trashMod as typeof import('../../server/src/services/trash-sheets')
const { purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')

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
const uid = uuid(), tid = uuid(), busy = uuid(), sorted = uuid(), gone = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
for (const [n, id] of [busy, sorted, gone].entries()) {
  addSheet.run(id, tid, uid, `S${n}`, n, JSON.stringify(['T']))
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) insert.run(uuid(), id, uid, i, JSON.stringify({ T: `t${i}` }))
  })()
}
const again = (sheetId: string) => ({ sheetId, operation: 'template' as const, template: '{{T}}-x', targetColumn: 'T' })
const dataVersion = (id: string) => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(id) as number
const suffixed = (id: string, glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.T') GLOB ?`).pluck().get(id, glob) as number
const records = (id: string) => db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(id)
const stoppedOn = async (id: string) => {
  fault.arm(251)
  try { return await transformColumn(uid, again(id)) } finally { fault.disarm() }
}

// Another connection, in a thread of its own: once told (flag 0), it takes the write lock, says so (flag 1) and
// holds it HOLD_MS, past the app connection's busy_timeout (5,000 ms, lib/db.ts), then lets it go.
const HOLD_MS = 6500
function lockHolder() {
  const flags = new Int32Array(new SharedArrayBuffer(8))
  const worker = new Worker(`const { workerData } = require('node:worker_threads');
    const Database = require(workerData.sqlite);
    const f = new Int32Array(workerData.flags.buffer);
    Atomics.wait(f, 0, 0);
    const db = new Database(workerData.dbPath);
    db.exec('BEGIN IMMEDIATE');
    Atomics.store(f, 1, 1); Atomics.notify(f, 1);
    Atomics.wait(f, 0, 1, workerData.holdMs);
    db.exec('ROLLBACK'); db.close();`, { eval: true, workerData: { flags, holdMs: HOLD_MS,
    sqlite: requireHere.resolve('better-sqlite3'), dbPath: process.env.DB_PATH } })
  const exited = new Promise((resolve, reject) => { worker.on('exit', resolve); worker.on('error', reject) })
  return { exited, lockNow() {
    Atomics.store(flags, 0, 1); Atomics.notify(flags, 0)
    assert.equal(Atomics.wait(flags, 1, 0, 3000), 'ok', 'the other connection took the lock')
  } }
}

async function main() {
  await check('a second page that waits out busy_timeout on another connection\'s lock: next_cursor and '
    + 'rows_done, in words naming SQLITE_BUSY; data_version moved; going on changes every row once', async () => {
    const holder = lockHolder()
    // The first checkpoint comes after the first page: the lock is taken there, before the second page.
    const pragma = db.pragma.bind(db)
    let armed = true
    db.pragma = ((src: string, opts?: object) => {
      if (armed && src.startsWith('wal_checkpoint')) { armed = false; holder.lockNow() }
      return pragma(src, opts)
    }) as typeof db.pragma
    const before = dataVersion(busy)
    const t0 = Date.now()
    let out
    try { out = await transformColumn(uid, again(busy)) } finally { db.pragma = pragma as typeof db.pragma }
    console.log(`      answered after ${Date.now() - t0} ms`)
    await holder.exited
    assert.ok('stopped' in out, JSON.stringify(out))
    const cursor = out.stopped.next_cursor
    assert.deepEqual(out.stopped, { error: 'Stopped on an error after 250 rows: the sheet was busy (SQLITE_BUSY). '
      + `Those rows are written. Call transform_column again with the same arguments and cursor set to "${cursor}" `
      + 'to go on. Don\'t start over without cursor: that would apply the operation to those rows again.',
    next_cursor: cursor, rows_done: 250 })
    assert.ok(dataVersion(busy) > before, 'data_version moved')
    assert.equal(suffixed(busy, 't*-x'), 250)
    assert.equal((await transformColumn(uid, again(busy)) as { fail: string }).fail, 'unfinished')
    assert.deepEqual(await transformColumn(uid, { ...again(busy), cursor }),
      { ok: { updated: ROWS - 250, created_column: null } })
    assert.equal(suffixed(busy, 't*-x'), ROWS)
    assert.equal(suffixed(busy, '*-x-x'), 0)
  })

  await check('after a sort, the record no longer holds: its cursor is refused and the call without cursor runs',
    async () => {
      const out = await stoppedOn(sorted)
      assert.ok('stopped' in out, JSON.stringify(out))
      assert.equal((await transformColumn(uid, again(sorted)) as { fail: string }).fail, 'unfinished')
      assert.ok('ok' in await physicalSortSheet(sorted, uid, 'T', 'desc'))
      assert.equal((await transformColumn(uid, { ...again(sorted), cursor: out.stopped.next_cursor }) as
        { fail: string }).fail, 'invalid')
      assert.deepEqual(await transformColumn(uid, again(sorted)), { ok: { updated: ROWS, created_column: null } })
      assert.equal(records(sorted), 0)
    })

  await check('the record stays while the sheet is in the trash and goes when it is deleted for good', async () => {
    assert.ok('stopped' in await stoppedOn(gone))
    assert.equal(records(gone), 1)
    const trashed = trashSheet(uid, tid, gone)
    assert.ok('ok' in trashed && trashed.ok.trashId !== null, JSON.stringify(trashed))
    assert.equal(records(gone), 1, 'kept in the trash: a restore brings the sheet back as it was')
    assert.deepEqual(purgeTrashItems(uid, [trashed.ok.trashId!]), [trashed.ok.trashId])
    const sheet = db.prepare('SELECT count(*) FROM sheets WHERE id = ?').pluck()
    for (const until = Date.now() + 10_000; sheet.get(gone) !== 0 && Date.now() < until;) {
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal(sheet.get(gone), 0, 'the sheet was deleted for good')
    assert.equal(records(gone), 0)
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-stop-busy assertions passed.')
    process.exit(0)
  })

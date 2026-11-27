// Rows auto-dedupe takes out of a sheet are written twice in the transaction that decides it: into the trash, and
// zeroed out of the rows (secure_delete). With keep newest, a 15 MB move replacing 150 rows of 200 KB wrote 90 MB of
// WAL in one commit, and a slice of the background round removing 150 of them 60 MB: past journal_size_limit, which
// counted only the rows moved (TRANSFER_MAX_MOVE_BYTES). The removal now has a budget of bytes written
// (lib/constants-dedupe.ts): transfer_rows gives it what its cap leaves, a background slice AUTO_DEDUPE_CHECK_BYTES
// (a row past it still goes, alone). Checks past it are made by the background round: the answer counts them in
// checking_later, auto-run waits for them, and the sheet ends as it would have. Small rows are settled as before.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
import { sqliteWriteProbe } from './sqlite-write-probe'
const { db, uid, tid, ok, done } = columnTrashKit('auto-dedupe-bytes')
const { transferRows } = await import('../../server/src/services/rows-transfer')
const { insertAutoDedupeSetting } = await import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet } = await import('../../server/src/services/auto-dedupe-index')
const { runChecks } = await import('../../server/src/services/auto-dedupe-checks')
const { autoDedupeChecking } = await import('../../server/src/lib/auto-dedupe/store')
const { AUTO_DEDUPE_CHECK_BYTES } = await import('../../server/src/lib/constants-dedupe')
const { TRANSFER_MAX_STORED_BYTES } = await import('../../server/src/lib/api-v1-constants')
console.error = () => {}
const probe = sqliteWriteProbe(db, process.env.DB_PATH!)
const sizeLimit = db.pragma('journal_size_limit', { simple: true }) as number
const pageSize = db.pragma('page_size', { simple: true }) as number

// A sheet of n rows: Email k<i>@x.co from `first`, a Json cell of `cell` characters, Who naming the sheet.
function sheet(n: number, cell: number, who: string, first = 0): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['Email', 'Json', 'Who']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(uuid(), sid, uid, i, JSON.stringify({ Email: `k${first + i}@x.co`, Json: 'j'.repeat(cell), Who: who }))
    }
  }).immediate()
  return sid
}
async function dedupe(sid: string, keep: 'oldest' | 'newest', build = true) {
  insertAutoDedupeSetting(uid, sid, 'Email', 'email', null, keep)
  if (build) assert.equal(await maintainAutoDedupeSheet(sid, uid, Date.now() + 30_000), 'ready')
}
const who = (sid: string) => db.prepare(`SELECT json_extract(data, '$.Who') AS w, count(*) AS n FROM rows
  WHERE sheet_id = ? GROUP BY w ORDER BY w`).all(sid) as Array<{ w: string; n: number }>
const transfer = (src: string, dest: string, operation: 'copy' | 'move') => {
  const out = transferRows(uid, {
    sourceSheetId: src, destinationSheetId: dest, operation, selection: { all: true },
    columnMode: 'create_missing', columnModeOmitted: false, columnMapping: {}, idempotencyKey: uuid(),
  }, 'mcp')
  assert.ok('ok' in out, JSON.stringify(out).slice(0, 300))
  return out.ok
}
// The most one transaction wrote while `f` ran, in bytes.
async function most(f: () => unknown): Promise<number> {
  db.pragma('wal_checkpoint(TRUNCATE)')
  probe.reset()
  await f()
  return probe.read().mostTransactionFrames * pageSize
}
const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`
const background = (sid: string) => runChecks(sid, uid, { ownBusy: false, deadline: Date.now() + 30_000 })

await ok('a 15 MB move replacing 150 rows of 200 KB: its commit under the limit, the rest later', async () => {
  const dest = sheet(150, 200_000, 'old'), src = sheet(150, 100_000, 'new')
  await dedupe(dest, 'newest')
  let out!: ReturnType<typeof transfer>
  const wrote = await most(() => { out = transfer(src, dest, 'move') })
  assert.ok(wrote < sizeLimit, `the move wrote ${mb(wrote)} in one commit`)
  const a = out.auto_dedupe!
  assert.ok(a.replaced_count > 0 && a.replaced_count < 150, JSON.stringify(a).slice(0, 200))
  assert.equal(a.replaced_count + a.checking_later!, 150)
  assert.equal(autoDedupeChecking(dest), true, 'auto-run waits for the checks still to make')
  const slice = await most(() => background(dest))
  assert.ok(slice < 2 * AUTO_DEDUPE_CHECK_BYTES, `a background slice wrote ${mb(slice)}`)
  assert.deepEqual(who(dest), [{ w: 'new', n: 150 }])
  assert.equal(autoDedupeChecking(dest), false)
})

await ok('a copy at its cap, every row a repeat (keep oldest): its commit under the limit', async () => {
  const n = Math.floor(TRANSFER_MAX_STORED_BYTES / 100_100)
  const dest = sheet(n, 1_000, 'old'), src = sheet(n, 100_000, 'new')
  await dedupe(dest, 'oldest')
  let out!: ReturnType<typeof transfer>
  const wrote = await most(() => { out = transfer(src, dest, 'copy') })
  assert.ok(wrote < sizeLimit, `the copy wrote ${mb(wrote)} in one commit`)
  assert.equal(out.auto_dedupe!.not_kept_count + out.auto_dedupe!.checking_later!, n)
  await background(dest)
  assert.deepEqual(who(dest), [{ w: 'old', n }])
})

await ok('rows that came while keys were built: each background slice within its bytes, a big row alone', async () => {
  const dest = sheet(150, 200_000, 'old')
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Json', ?) WHERE sheet_id = ? AND row_index = 0`)
    .run('j'.repeat(AUTO_DEDUPE_CHECK_BYTES), dest)
  await dedupe(dest, 'newest', false)
  const out = transfer(sheet(150, 1_000, 'new'), dest, 'copy')
  assert.equal(out.auto_dedupe!.checking_later, 150)
  assert.equal(await maintainAutoDedupeSheet(dest, uid, Date.now() + 30_000), 'ready')
  const slice = await most(() => background(dest))
  assert.ok(slice < 3 * AUTO_DEDUPE_CHECK_BYTES, `a background slice wrote ${mb(slice)}`)
  assert.deepEqual(who(dest), [{ w: 'new', n: 150 }])
})

await ok('small rows settle in the call as before: 10,000 replaced, nothing left for later', async () => {
  const dest = sheet(10_000, 100, 'old'), src = sheet(10_000, 100, 'new')
  await dedupe(dest, 'newest')
  const a = transfer(src, dest, 'copy').auto_dedupe!
  assert.equal(a.replaced_count, 10_000)
  assert.equal(a.checking_later, undefined)
  assert.deepEqual(who(dest), [{ w: 'new', n: 10_000 }])
})

done()

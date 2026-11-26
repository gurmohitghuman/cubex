// transfer_rows is one transaction, all or nothing (services/rows-transfer.ts), and a move writes each row about
// three times: into the destination, into the trash, and zeroed out of the source. Moving 30 MB of rows (300 of
// 100 KB) wrote about 19,650 pages, 77 MB of WAL, past journal_size_limit in one commit. A move now takes at most
// TRANSFER_MAX_MOVE_BYTES of the source rows (half of a copy's TRANSFER_MAX_STORED_BYTES): past it the call is
// refused, naming both caps, and nothing moves. A move under it writes one transaction under journal_size_limit,
// and a copy of 30 MB still goes.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
import { sqliteWriteProbe } from './sqlite-write-probe'
const { db, uid, tid, ok, done } = columnTrashKit('transfer-move-bytes')
const { transferRows } = await import('../../server/src/services/rows-transfer')
const { TRANSFER_MAX_MOVE_BYTES, TRANSFER_MAX_STORED_BYTES } = await import('../../server/src/lib/api-v1-constants')
console.error = () => {}
const probe = sqliteWriteProbe(db, process.env.DB_PATH!)
const sizeLimit = db.pragma('journal_size_limit', { simple: true }) as number
const pageSize = db.pragma('page_size', { simple: true }) as number

const CELL = 100_000
function sheet(n: number): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['Email', 'Json']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(uuid(), sid, uid, i, JSON.stringify({ Email: `u${i}@x.co`, Json: `${i}:${'j'.repeat(CELL)}` }))
    }
  }).immediate()
  return sid
}
const rows = (sid: string) => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const trashItems = () => db.prepare('SELECT count(*) FROM trash_items').pluck().get() as number
const transfer = (src: string, dest: string, operation: 'copy' | 'move') => transferRows(uid, {
  sourceSheetId: src, destinationSheetId: dest, operation, selection: { all: true },
  columnMode: 'create_missing', columnModeOmitted: false, columnMapping: {}, idempotencyKey: uuid(),
}, 'mcp')

await ok('the caps: a move half a copy\'s, and 30 MB of rows between them', () => {
  assert.equal(TRANSFER_MAX_MOVE_BYTES, TRANSFER_MAX_STORED_BYTES / 2)
  assert.ok(300 * CELL > TRANSFER_MAX_MOVE_BYTES && 300 * CELL < TRANSFER_MAX_STORED_BYTES)
})

await ok('a move past its cap is refused, naming it, and nothing moves', () => {
  const src = sheet(300), dest = sheet(0)
  const before = trashItems()
  const out = transfer(src, dest, 'move')
  assert.ok('fail' in out && out.fail === 'budget', JSON.stringify(out).slice(0, 300))
  assert.match((out as { error: string }).error, /16 MB .*move.* 32 MB/)
  assert.match((out as { error: string }).error, /picked 300 rows holding 29 MB\. Transfer fewer rows a call\./)
  assert.equal(rows(src), 300)
  assert.equal(rows(dest), 0)
  assert.equal(trashItems(), before)
})

// One row past a move's cap can't be moved in fewer rows: the answer says to copy it, then delete it.
await ok('one row past a move\'s cap: the refusal says to copy it, then delete_rows', () => {
  const src = sheet(0), dest = sheet(0)
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)').run(uuid(), src, uid, 0,
    JSON.stringify({ Email: 'big@x.co', Json: 'j'.repeat(TRANSFER_MAX_MOVE_BYTES + 1_000) }))
  const out = transfer(src, dest, 'move')
  assert.ok('fail' in out && out.fail === 'budget', JSON.stringify(out).slice(0, 300))
  assert.match((out as { error: string }).error, /picked 1 row holding 16 MB\. Copy that row instead, then delete it/)
  assert.equal(rows(src), 1)
})

await ok('a move under its cap goes, its one transaction under journal_size_limit', () => {
  const src = sheet(150), dest = sheet(0)
  db.pragma('wal_checkpoint(TRUNCATE)')
  probe.reset()
  const out = transfer(src, dest, 'move')
  assert.ok('ok' in out && out.ok.moved === 150, JSON.stringify(out).slice(0, 300))
  const frames = probe.read().mostTransactionFrames
  assert.ok(frames * pageSize < sizeLimit, `the move wrote ${frames} pages in one transaction`)
  assert.equal(rows(src), 0)
  assert.equal(rows(dest), 150)
})

await ok('a copy of 30 MB still goes', () => {
  const src = sheet(300), dest = sheet(0)
  const out = transfer(src, dest, 'copy')
  assert.ok('ok' in out && out.ok.copied === 300, JSON.stringify(out).slice(0, 300))
  assert.equal(rows(dest), 300)
})

done()

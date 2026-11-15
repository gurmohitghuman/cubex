// The trash's background bulk writers, each measured (bulk-wal-kit.ts): a column's move into the trash and back
// (lib/column-purge.ts, services/trash-restore-column.ts), rows moved into it and back (services/trash-batch.ts,
// trash-restore.ts), and the trash emptied (trash-purge.ts). Rows with random ids, enough for the WAL to reach the
// bulk pause (the emptying writes less), and each checkpoint on the worker held 300 ms: the event loop is never held
// 200 ms, no checkpoint's sync runs on the API thread, the WAL stays under journal_size_limit, SQLite's own
// checkpoint is back on afterwards, and every row and cell ends where it should.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, tid, ok, done, idle, del, restoreOne, item } = columnTrashKit('bulk-wal-trash')
const { trashRowRange } = await import('../../server/src/services/trash-batch')
const { purgeTrashItems } = await import('../../server/src/services/trash-purge')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const N = 20_000
// A column's cells write few pages a row (copied into the item in order, stripped from rows): three times as many
// rows reach the pause.
const COLUMN_ROWS = 60_000
// n rows with random ids (as older sheets have: each row on a page of its own) and a 300-character Big cell.
function sheet(n = N): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['Email', 'Big']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(uuid(), sid, uid, i, JSON.stringify({ Email: `u${i}@x.co`, Big: `v${i}:${'x'.repeat(300)}` }))
    }
  }).immediate()
  return sid
}
const rows = (sid: string) => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const bigCells = (sid: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.Big') LIKE 'v%'`).pluck().get(sid) as number
const kept = (id: number) => db.prepare('SELECT count(*) FROM trash_rows WHERE item_id = ?').pluck().get(id) as number
const until = async (what: () => boolean, ms = 120_000) => {
  for (const end = Date.now() + ms; !what() && Date.now() < end;) await new Promise(r => setTimeout(r, 20))
  return what()
}

await ok('a column into the trash and back: the WAL copied back on the worker', async () => {
  const sid = sheet(COLUMN_ROWS)
  let id: number | null = null
  await measure('a column into the trash', async () => { id = await del(sid, 'Big') }, { pause: true })
  assert.ok(id !== null && item(id).state === 'kept', JSON.stringify(id && item(id)))
  assert.equal(kept(id!), COLUMN_ROWS, 'every cell in the item')
  assert.equal(bigCells(sid), 0)
  await measure('the column back', async () => {
    const r = await restoreOne(id!)
    assert.ok(r && ('restored' in r || 'restoring' in r), JSON.stringify(r))
    await idle(sid)
  }, { pause: true })
  assert.equal(bigCells(sid), COLUMN_ROWS, 'every cell back')
})

await ok('rows into the trash and back, then the trash emptied: the WAL copied back on the worker', async () => {
  const sid = sheet()
  let moved = { trashId: null as number | null, moved: 0 }
  await measure('rows into the trash', async () => { moved = await trashRowRange(sid, uid, 0, N, 'import') },
    { pause: true })
  assert.equal(moved.moved, N)
  assert.equal(rows(sid), 0)
  const id = moved.trashId!
  await measure('the rows back', async () => {
    const r = await restoreOne(id)
    assert.ok(r && ('restored' in r || 'restoring' in r), JSON.stringify(r))
    await idle(sid)
  }, { pause: true })
  assert.equal(rows(sid), N, 'every row back')
  moved = await trashRowRange(sid, uid, 0, N, 'import')
  const again = moved.trashId!
  await measure('the trash emptied', async () => {
    assert.deepEqual(purgeTrashItems(uid, [again]), [again])
    assert.ok(await until(() => !item(again)), 'the item is gone')
  })
  assert.equal(kept(again), 0)
})

await closeWalCheckpointer()
done()

// Slices sized by bytes (lib/slice-bytes.ts, HEAVY_SLICE_BYTES) in the trash and duplicate removal: rows holding a
// 100 KB answer each, which went 250 to a slice before (each row written twice: about 12,300 frames, 48 MB of WAL
// in one commit; the trash emptied, 29,400 frames, 116 MB). Each job is measured (bulk-wal-kit.ts: every checkpoint
// on the worker held 300 ms, the event loop never held 200 ms, the WAL under journal_size_limit) and no slice writes
// much past HEAVY_SLICE_BYTES: rows into the trash and back, the trash emptied, a big column into the trash and
// back, duplicates removed (a journaled chunk that doesn't fit keeps the rest); every row and cell ends where it
// should. Last, the trash emptied finds each slice's rows by rowid, not by walking the batch's whole index. The
// row walk and an import's undo: bulk-wal-big-rows.test.ts.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
import { bulkWalKit } from './bulk-wal-kit'
const { db, uid, tid, ok, done, idle, del, restoreOne, item } = columnTrashKit('bulk-wal-big-trash')
const { trashRowRange } = await import('../../server/src/services/trash-batch')
const { purgeTrashItems } = await import('../../server/src/services/trash-purge')
const { removeDuplicates } = await import('../../server/src/services/dedupe-remove')
const { HEAVY_SLICE_BYTES } = await import('../../server/src/lib/constants')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

const MOST_FRAMES = Math.ceil((1.5 * HEAVY_SLICE_BYTES) / 4096)
const N = 600, CELL = 100_000
// n rows with random ids and a 100 KB Json cell; `dupes`: each Email twice.
function sheet(dupes = false): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['Email', 'Json']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      ins.run(uuid(), sid, uid, i, JSON.stringify({ Email: `u${dupes ? i % (N / 2) : i}@x.co`,
        Json: `${i}:${'j'.repeat(CELL)}` }))
    }
  }).immediate()
  return sid
}
const rows = (sid: string) => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const bigCells = (sid: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND length(json_extract(data, '$.Json')) > ?`).pluck().get(sid, CELL) as number
const kept = (id: number) => db.prepare('SELECT count(*) FROM trash_rows WHERE item_id = ?').pluck().get(id) as number
const sized = (r: { w: { mostTransactionFrames: number } }, what: string) =>
  assert.ok(r.w.mostTransactionFrames <= MOST_FRAMES, `${what}: a slice wrote ${r.w.mostTransactionFrames} frames`)
const until = async (what: () => boolean, ms = 120_000) => {
  for (const end = Date.now() + ms; !what() && Date.now() < end;) await new Promise(r => setTimeout(r, 20))
  return what()
}

await ok('rows into the trash and back, then the trash emptied: slices sized by bytes', async () => {
  const sid = sheet()
  let moved = { trashId: null as number | null, moved: 0 }
  sized(await measure('rows into the trash', async () => { moved = await trashRowRange(sid, uid, 0, N, 'import') }),
    'into the trash')
  assert.equal(moved.moved, N)
  sized(await measure('the rows back', async () => {
    const r = await restoreOne(moved.trashId!)
    assert.ok(r && ('restored' in r || 'restoring' in r), JSON.stringify(r))
    await idle(sid)
  }), 'back')
  assert.equal(bigCells(sid), N, 'every row back whole')
  const again = (await trashRowRange(sid, uid, 0, N, 'import')).trashId!
  sized(await measure('the trash emptied', async () => {
    assert.deepEqual(purgeTrashItems(uid, [again]), [again])
    assert.ok(await until(() => !item(again)), 'the item is gone')
  }), 'emptied')
  assert.equal(kept(again), 0)
})

await ok('a big column into the trash and back: slices sized by bytes', async () => {
  const sid = sheet()
  let id: number | null = null
  sized(await measure('a column into the trash', async () => { id = await del(sid, 'Json') }), 'column into the trash')
  assert.ok(id !== null && item(id).state === 'kept', JSON.stringify(id && item(id)))
  assert.equal(kept(id!), N, 'every cell in the item')
  sized(await measure('the column back', async () => {
    const r = await restoreOne(id!)
    assert.ok(r && ('restored' in r || 'restoring' in r), JSON.stringify(r))
    await idle(sid)
  }), 'column back')
  assert.equal(bigCells(sid), N, 'every cell back')
})

await ok('duplicates removed: slices sized by bytes, each journaled chunk kept until its last row goes', async () => {
  const sid = sheet(true)
  let out: Awaited<ReturnType<typeof removeDuplicates>> | null = null
  sized(await measure('duplicates removed', async () => {
    out = await removeDuplicates(uid, sid, { columns: [{ column: 'Email', match: 'email' }] })
  }), 'duplicates')
  assert.ok(out && 'ok' in out && out.ok.removed === N / 2, JSON.stringify(out))
  assert.equal(rows(sid), N / 2)
  assert.equal(db.prepare('SELECT COUNT(*) FROM dedupe_chunks WHERE sheet_id = ?').pluck().get(sid), 0)
})

await ok('the trash emptied finds each slice\'s rows by rowid', async () => {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['Email']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => { for (let i = 0; i < 50; i++) ins.run(uuid(), sid, uid, i, `{"Email":"u${i}@x.co"}`) })
    .immediate()
  const id = (await trashRowRange(sid, uid, 0, 50, 'import')).trashId!
  // The plan of each statement the purge prepares that deletes rows of trash_rows by rowid.
  const plans: string[] = []
  const prepare = db.prepare.bind(db)
  ;(db as any).prepare = (sql: string) => {
    if (/^DELETE FROM trash_rows WHERE rowid IN/.test(sql)) {
      const params = Array((sql.match(/\?/g) ?? []).length).fill(null)
      plans.push((prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map(p => p.detail).join(' | '))
    }
    return prepare(sql)
  }
  try {
    assert.deepEqual(purgeTrashItems(uid, [id]), [id])
    assert.ok(await until(() => !item(id)), 'the item is gone')
  } finally { (db as any).prepare = prepare }
  assert.equal(kept(id), 0)
  assert.ok(plans.length > 0, 'the purge deleted from trash_rows')
  for (const p of plans) assert.match(p, /^SEARCH trash_rows USING INTEGER PRIMARY KEY \(rowid=\?\)/, p)
})

await closeWalCheckpointer()
done()

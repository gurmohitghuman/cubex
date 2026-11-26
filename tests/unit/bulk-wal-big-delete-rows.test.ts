// Rows a request deletes, on rows with big cells (services/trash-rows-sliced.ts, HEAVY_SLICE_BYTES): the grid's
// delete (up to 10,000 rows a call) and delete_rows over REST and MCP (1,000) went in one transaction whatever the
// rows held, so 300 rows of 100 KB into the trash wrote past the WAL's 64 MB in one commit. Each delete is measured
// (bulk-wal-kit.ts: every checkpoint on the worker held 300 ms, the event loop never held 200 ms, the WAL under
// journal_size_limit) and no slice writes much past HEAVY_SLICE_BYTES: the grid's delete in two calls (one batch,
// one History line) and delete_rows by ids. Rows that fit one slice still go in one transaction, answered at once.
// A delete a restart cut short leaves its batch moving: the boot seals it with its History line, or drops it empty.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
import { bulkWalKit } from './bulk-wal-kit'
import mutateMod from '../../server/src/routes/sheets-rows-mutate'
const { db, uid, tid, ok, done, item, history } = columnTrashKit('bulk-wal-big-delete-rows')
const { deleteRowsByIdsSliced } = await import('../../server/src/services/rows-write')
const { sealLeftDeletes } = await import('../../server/src/services/trash-rows-sliced')
const { removeRows } = await import('../../server/src/lib/trash/move')
const { insertTrashItem } = await import('../../server/src/lib/trash/store')
const { HEAVY_SLICE_BYTES } = await import('../../server/src/lib/constants')
const { nextRowIndex } = await import('../../server/src/lib/sheet-busy')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()

type Handle = (req: object, res: object) => unknown
type Layer = { route?: { path: string; stack: Array<{ handle: Handle }> } }
// The grid's route itself, past its session check (the router's first layer).
const bulkDelete = ((mutateMod as unknown as { default: { stack: Layer[] } }).default.stack
  .find(l => l.route?.path === '/:id/rows/bulk-delete')!).route!.stack[0].handle

const MOST_FRAMES = Math.ceil((1.5 * HEAVY_SLICE_BYTES) / 4096)
const N = 600, CELL = 100_000
function sheet(n: number, cell: number): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['Email', 'Json']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(uuid(), sid, uid, i, JSON.stringify({ Email: `u${i}@x.co`, Json: `${i}:${'j'.repeat(cell)}` }))
    }
  }).immediate()
  return sid
}
const rows = (sid: string) => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const ids = (sid: string) => db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(sid) as string[]
const kept = (id: number) => db.prepare(`SELECT count(*) FROM trash_rows WHERE item_id = ?
  AND length(data) > ?`).pluck().get(id, CELL) as number
const version = (sid: string) => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(sid) as number
const sized = (r: { w: { mostTransactionFrames: number } }, what: string) =>
  assert.ok(r.w.mostTransactionFrames <= MOST_FRAMES, `${what}: a slice wrote ${r.w.mostTransactionFrames} frames`)
const lines = (sid: string) => history(sid).filter(h => h.action === 'rows_deleted').map(h => h.summary)
interface Res { code: number; body: any; status(c: number): Res; json(b: unknown): Res }
const res = (): Res => ({ code: 200, body: null,
  status(c) { this.code = c; return this }, json(b) { this.body = b; return this } })
// The grid's delete of these rows; `trashId`: an earlier call's batch.
function grid(sid: string, rowIndices: number[], trashId?: number) {
  const rowGeneration = db.prepare('SELECT row_generation FROM sheets WHERE id = ?').pluck().get(sid)
  const r = res()
  const done = bulkDelete({ params: { id: sid }, userId: uid,
    body: { rowIndices, rowGeneration, ...(trashId === undefined ? {} : { trashId }) } }, r)
  return { r, done }
}
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i)

await ok('the grid\'s delete in two calls: slices sized by bytes, one batch, one History line', async () => {
  const sid = sheet(N, CELL)
  let first: Res | null = null, second: Res | null = null
  sized(await measure('the grid\'s delete', async () => {
    const a = grid(sid, range(0, N / 2))
    await a.done
    first = a.r
    const b = grid(sid, range(N / 2, N), first.body?.trash?.id)
    await b.done
    second = b.r
  }), 'the grid\'s delete')
  assert.equal(first!.code, 200, JSON.stringify(first!.body))
  assert.equal(second!.code, 200, JSON.stringify(second!.body))
  assert.equal(first!.body.deletedCount, N / 2)
  assert.equal(second!.body.deletedCount, N / 2)
  const id = first!.body.trash.id as number
  assert.equal(second!.body.trash.id, id, 'one batch')
  assert.equal(rows(sid), 0)
  assert.equal(kept(id), N, 'every row in the batch whole')
  assert.equal(item(id)!.state, 'kept')
  assert.deepEqual(lines(sid), [`Deleted ${N} rows`])
})

await ok('delete_rows by ids: slices sized by bytes, into one batch, open tabs told', async () => {
  const sid = sheet(N, CELL)
  const before = version(sid)
  let out: Awaited<ReturnType<typeof deleteRowsByIdsSliced>> | null = null
  const picked = ids(sid).slice(0, 500)
  const r = await measure('delete_rows', async () => { out = await deleteRowsByIdsSliced(sid, uid, picked) })
  sized(r, 'delete_rows')
  assert.ok(out && 'ok' in out && out.ok.deleted === 500, JSON.stringify(out))
  const id = (out as unknown as { ok: { trashId: number } }).ok.trashId
  assert.equal(rows(sid), N - 500)
  assert.equal(kept(id), 500)
  assert.equal(item(id)!.state, 'kept')
  assert.ok(version(sid) > before, 'data_version moved')
  assert.deepEqual(lines(sid), ['Deleted 500 rows'])
})

// The last rows of a sheet deleted in slices: an append while it goes (a webhook) must land above all of them, or the
// last transaction's auto-run fence passes over it (it would never be filled). Asked through the delete, including
// while it waits for the worker's (held) checkpoint after its last slice.
await ok('rows added while a sliced delete goes land above every row it may remove', async () => {
  const sid = sheet(N, CELL)
  const picked = ids(sid).slice(N - 300)
  let lowest = Infinity
  await measure('delete_rows of the last rows, appends asked meanwhile', async () => {
    let settled = false
    const going = deleteRowsByIdsSliced(sid, uid, picked).finally(() => { settled = true })
    while (!settled) {
      lowest = Math.min(lowest, nextRowIndex(sid, uid))
      await new Promise(r => setTimeout(r, 2))
    }
    await going
  })
  assert.equal(rows(sid), N - 300)
  assert.ok(lowest >= N, `an append meanwhile would have gone to ${lowest}, among the rows deleted`)
})

await ok('rows that fit one slice: one transaction, answered at once', async () => {
  const sid = sheet(50, 10)
  const { r, done } = grid(sid, [1, 2, 3])
  assert.equal(r.code, 200, 'answered before anything was awaited')
  assert.equal(r.body?.deletedCount, 3)
  await done
  const out = await deleteRowsByIdsSliced(sid, uid, ids(sid).slice(0, 2))
  assert.ok('ok' in out && out.ok.deleted === 2, JSON.stringify(out))
  assert.equal(rows(sid), 45)
})

await ok('a delete a restart cut short: its batch is sealed at boot with its History line; an empty one goes', () => {
  const sid = sheet(10, 10)
  const columns = ['Email', 'Json']
  const moving = insertTrashItem({ userId: uid, kind: 'rows', how: 'grid', tableId: tid, sheetId: sid, columns,
    state: 'moving' })
  const rowids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? AND row_index < 4').pluck().all(sid) as number[]
  removeRows(sid, uid, { rowids }, moving)
  const empty = insertTrashItem({ userId: uid, kind: 'rows', how: 'api', tableId: tid, sheetId: sid, columns,
    state: 'moving' })
  const before = version(sid)
  sealLeftDeletes()
  assert.equal(item(moving)!.state, 'kept')
  assert.equal(item(moving)!.row_count, 4)
  assert.equal(item(empty), undefined)
  assert.deepEqual(lines(sid), ['Deleted 4 rows'])
  assert.ok(version(sid) > before, 'open tabs told')
})

await closeWalCheckpointer()
done()

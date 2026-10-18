// Deleted rows kept in the trash (migration 036, services/trash-*.ts) against a
// real database. Pins: a delete moves the rows whole into one batch (results
// go), a grid delete in several calls lands in one batch, nothing is kept at 0
// days; a restore puts rows back at their old places with their ids while the
// sheet wasn't reordered, else at the end in their order, adds back columns
// the sheet lost (any case maps to the existing one), empties "⏳" cells, skips
// auto-run, restores rows picked from a batch, and waits for a run to finish.
import assert from 'node:assert/strict'
import restoreMod from '../../server/src/services/trash-restore'
import storeMod from '../../server/src/lib/trash/store'
import readMod from '../../server/src/services/trash-read'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
const { restoreRows } = restoreMod as typeof import('../../server/src/services/trash-restore')
const { setTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
const { readTrashRows } = readMod as typeof import('../../server/src/services/trash-read')
const { db, uid, ok, done, idle, fixture, rowsOf, item, del } = trashKit('trash-rows')

await ok('a delete moves the rows whole into one batch, and their results go', () => {
  const sid = fixture(20)
  const before = rowsOf(sid)
  const out = del(sid, [0, 6, 12])
  assert.equal(out.count, 3)
  assert.ok(out.trashId !== null)
  assert.equal(rowsOf(sid).length, 17)
  const it = item(out.trashId!)!
  assert.equal(it.row_count, 3)
  assert.equal(it.state, 'kept')
  assert.deepEqual(JSON.parse(it.columns), ['Email', 'Name'])
  assert.ok(it.bytes > 0)
  const kept = db.prepare('SELECT seq, row_index, row_id, data FROM trash_rows WHERE item_id = ? ORDER BY seq')
    .all(out.trashId) as Array<{ seq: number; row_index: number; row_id: string; data: string }>
  assert.deepEqual(kept.map(r => r.row_index), [0, 6, 12])
  assert.deepEqual(kept.map(r => r.row_id), [before[0].id, before[3].id, before[6].id])
  assert.equal(kept[1].data, before[3].data)
  const results = db.prepare(`SELECT row_index FROM ai_results WHERE run_id IN
    (SELECT id FROM ai_runs WHERE sheet_id = ?)`).pluck().all(sid) as number[]
  assert.ok(!results.includes(0) && !results.includes(6) && !results.includes(12), 'their results went')
  const line = db.prepare("SELECT summary, detail FROM sheet_changes WHERE sheet_id = ? AND action = 'rows_deleted'")
    .get(sid) as { summary: string; detail: string }
  assert.equal(line.summary, 'Deleted 3 rows')
  assert.equal(JSON.parse(line.detail).trash_id, out.trashId)
})

await ok('a grid delete in several calls lands in one batch; the log line counts them all', () => {
  const sid = fixture(10)
  const first = del(sid, [0, 2])
  const second = del(sid, [4, 6, 8], first.trashId!)
  assert.equal(second.trashId, first.trashId)
  assert.equal(item(first.trashId!)!.row_count, 5)
  const lines = db.prepare("SELECT summary FROM sheet_changes WHERE sheet_id = ? AND action = 'rows_deleted'")
    .pluck().all(sid) as string[]
  assert.deepEqual(lines, ['Deleted 5 rows'])
  const other = fixture(4)
  const elsewhere = del(other, [0], first.trashId!)
  assert.notEqual(elsewhere.trashId, first.trashId, "another sheet's batch is never continued")
})

await ok('kept 0 days: rows are deleted at once, no batch', () => {
  setTrashDays(uid, 0)
  try {
    const sid = fixture(5)
    const out = del(sid, [0, 2])
    assert.equal(out.count, 2)
    assert.equal(out.trashId, null)
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM trash_items WHERE sheet_id = ?').get(sid) as
      { c: number }).c, 0)
  } finally { setTrashDays(uid, 30) }
})

await ok('restore: old places and ids while the sheet was not reordered; the batch leaves the trash', async () => {
  const sid = fixture(12)
  const before = rowsOf(sid)
  const out = del(sid, [4, 10, 22])
  const back = await restoreRows(uid, out.trashId!)
  assert.ok('ok' in back, JSON.stringify(back))
  assert.equal(back.ok.place, 'old')
  assert.equal(back.ok.state, 'restored')
  await idle(sid)
  assert.deepEqual(rowsOf(sid), before, 'every row back where it was, same id and cells')
  assert.equal(item(out.trashId!), undefined)
  const line = db.prepare("SELECT summary FROM sheet_changes WHERE sheet_id = ? AND action = 'rows_restored'")
    .pluck().get(sid)
  assert.equal(line, 'Restored 3 rows to their old places')
})

await ok('restore after a reorder: the end of the sheet, in their order', async () => {
  const sid = fixture(6)
  const out = del(sid, [2, 6])
  db.prepare('UPDATE sheets SET row_generation = row_generation + 1 WHERE id = ?').run(sid)
  const back = await restoreRows(uid, out.trashId!)
  assert.ok('ok' in back && back.ok.place === 'end')
  await idle(sid)
  const rows = rowsOf(sid)
  assert.deepEqual(rows.slice(-2).map(r => [r.row_index, r.id]), [[11, `r1-${sid}`], [12, `r3-${sid}`]])
})

await ok('restore: a place taken meanwhile sends the batch to the end', async () => {
  const sid = fixture(4)
  const out = del(sid, [6])
  db.prepare("INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,6,'{}')").run(uuid(), sid, uid)
  const back = await restoreRows(uid, out.trashId!)
  assert.ok('ok' in back && back.ok.place === 'end')
  await idle(sid)
  assert.equal(rowsOf(sid).at(-1)!.id, `r3-${sid}`)
})

await ok('restore adds back lost columns, maps any case, empties run placeholders', async () => {
  const sid = fixture(3, ['Email', 'Name', 'Score'])
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Score', '⏳ Processing...') WHERE id = ?`).run(`r0-${sid}`)
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Score', '7') WHERE id = ?`).run(`r1-${sid}`)
  const out = del(sid, [0, 2])
  db.prepare(`UPDATE sheets SET column_order = '["email"]' WHERE id = ?`).run(sid)
  const back = await restoreRows(uid, out.trashId!)
  assert.ok('ok' in back, JSON.stringify(back))
  assert.deepEqual(back.ok.columns_added, ['Name', 'Score'])
  await idle(sid)
  const order = JSON.parse((db.prepare('SELECT column_order FROM sheets WHERE id = ?').get(sid) as
    { column_order: string }).column_order)
  assert.deepEqual(order, ['email', 'Name', 'Score'])
  const r0 = JSON.parse(rowsOf(sid).find(r => r.id === `r0-${sid}`)!.data)
  assert.deepEqual(r0, { email: 'u0@a.com', Name: 'N0' }, 'Email lands in "email"; the ⏳ cell comes back empty')
  assert.equal(JSON.parse(rowsOf(sid).find(r => r.id === `r1-${sid}`)!.data).Score, '7')
})

await ok('restore picked rows: only those; the rest stay in the batch', async () => {
  const sid = fixture(6)
  const out = del(sid, [0, 2, 4, 6])
  const page = readTrashRows(uid, out.trashId!, { contains: 'N2' })
  assert.ok(!('fail' in page))
  assert.deepEqual(page.rows.map(r => r.row_id), [`r2-${sid}`])
  const back = await restoreRows(uid, out.trashId!, [page.rows[0].seq])
  assert.ok('ok' in back && back.ok.rows === 1)
  assert.equal(item(out.trashId!)!.row_count, 3)
  assert.equal(item(out.trashId!)!.state, 'kept')
  assert.ok(rowsOf(sid).some(r => r.id === `r2-${sid}`))
  const byColumn = readTrashRows(uid, out.trashId!, { column: 'Name', contains: 'n3' })
  assert.ok(!('fail' in byColumn) && byColumn.rows.length === 1, 'a column search ignores case')
})

await ok('restore leaves restored rows to auto-run (its fence passes them)', async () => {
  const sid = fixture(5)
  const out = del(sid, [2])
  db.prepare('UPDATE sheets SET row_generation = row_generation + 1 WHERE id = ?').run(sid)
  const entry = uuid()
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, input_columns,
    watermark_row_index, row_generation_seen) VALUES (?,?,?,?,?,?,?,?)`)
    .run(entry, uid, sid, 'Status', 'http', '["Email"]', 4, 1)
  await restoreRows(uid, out.trashId!)
  await idle(sid)
  const w = db.prepare('SELECT watermark_row_index FROM autorun_columns WHERE id = ?').pluck().get(entry) as number
  assert.equal(w, 9, 'the fence passes the restored row')
  const pending = db.prepare('SELECT row_id FROM autorun_pending WHERE autorun_id = ?').pluck().all(entry)
  assert.deepEqual(pending, [`r3-${sid}`, `r4-${sid}`], 'rows that were new to it stay new')
})

await ok('a run on the sheet refuses a restore', async () => {
  const sid = fixture(3)
  const out = del(sid, [0])
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status)
    VALUES (?,?,?,'Name','p','running')`).run(uuid(), sid, uid)
  const back = await restoreRows(uid, out.trashId!)
  assert.ok('fail' in back && back.fail === 'conflict')
  assert.equal(item(out.trashId!)!.state, 'kept')
})

done()

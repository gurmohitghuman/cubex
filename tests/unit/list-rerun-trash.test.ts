// A list job's rerun replacing the rows a source row added before, against a
// real database. Pins: the replaced rows go into the other sheet's rerun batch
// in the trash with their cells (never deleted outright), later reruns that day
// join the same batch and one History line counts them all, a restore puts them
// back (a partial one never lowers a line's count), and at 0 days they are gone
// at once with one line saying so.
import assert from 'node:assert/strict'
import addMod from '../../server/src/services/enrich-list-add'
import restoreMod from '../../server/src/services/trash-restore'
import storeMod from '../../server/src/lib/trash/store'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
const { addListItems } = addMod as typeof import('../../server/src/services/enrich-list-add')
const { restoreRows } = restoreMod as typeof import('../../server/src/services/trash-restore')
const { setTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
const { db, uid, tid, ok, done, idle, rowsOf } = trashKit('list-rerun-trash')

const src = uuid(), dest = uuid()
const sheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
sheet.run(src, tid, uid, 'Leads', 0, JSON.stringify(['Company', 'People']))
sheet.run(dest, tid, uid, 'People', 1, JSON.stringify(['Company', 'Name']))
const srcRows = [uuid(), uuid()]
srcRows.forEach((id, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(id, src, uid, i, JSON.stringify({ Company: `Co${i}`, People: '➕ Adding rows…' })))

const runId = uuid()
db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
  dest_sheet_id) VALUES (?, ?, ?, ?, 'completed', 0, 'People', ?)`).run(runId, src, uid, JSON.stringify({
  requestConfig: {}, responseMapping: [], enrichment: { v: 1, list: {
    destSheetId: dest, itemsPath: '$.output.people', provider: 'quickenrich', maxItems: 10,
    fields: [{ path: '$.name', columnName: 'Name' }], copy: [{ id: 'c1', from: 'Company', to: 'Company' }],
    dedupe: null,
  } } }), dest)

// One answer for a source row, added the way the drain adds it.
const answer = (rowId: string, names: string[]) => {
  const id = uuid()
  db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
    dest_sheet_id, items_json, item_count) VALUES (?,?,?,?,?,?,?,?)`).run(id, uid, runId, src, rowId, dest,
    JSON.stringify({ items: names.map(n => ({ name: n })), copy: { c1: 'Co' } }), names.length)
  const out = addListItems(id)
  assert.ok('added' in out, `added: ${JSON.stringify(out)}`)
}
const names = () => rowsOf(dest).map(r => JSON.parse(r.data).Name as string)
const rerunBatches = () => db.prepare(`SELECT id, row_count, state FROM trash_items WHERE sheet_id = ?
  AND how = 'rerun' ORDER BY id`).all(dest) as Array<{ id: number; row_count: number; state: string }>
const lines = () => db.prepare(`SELECT summary, detail FROM sheet_changes WHERE sheet_id = ?
  AND action = 'rows_deleted' ORDER BY id`).all(dest) as Array<{ summary: string; detail: string }>

await ok('a rerun moves the rows its source row added before into the trash, cells and all', () => {
  answer(srcRows[0], ['Ada', 'Grace'])
  answer(srcRows[1], ['Edsger'])
  const first = rowsOf(dest).filter(r => ['Ada', 'Grace'].includes(JSON.parse(r.data).Name))
  answer(srcRows[0], ['Barbara'])
  assert.deepEqual(names().sort(), ['Barbara', 'Edsger'])
  const [batch] = rerunBatches()
  assert.ok(batch, 'a rerun batch exists')
  assert.equal(batch.row_count, 2)
  assert.equal(batch.state, 'kept')
  const kept = db.prepare('SELECT row_id, data FROM trash_rows WHERE item_id = ? ORDER BY seq')
    .all(batch.id) as Array<{ row_id: string; data: string }>
  assert.deepEqual(kept.map(r => r.row_id), first.map(r => r.id))
  assert.deepEqual(kept.map(r => r.data), first.map(r => r.data))
  assert.deepEqual(lines().map(l => l.summary), ['A rerun replaced 2 rows it had added before'])
  assert.equal(JSON.parse(lines()[0].detail).trash_id, batch.id)
})

await ok('more reruns that day join the batch, and its one History line counts them all', () => {
  answer(srcRows[1], ['Ken', 'Radia'])
  answer(srcRows[0], [])
  const batches = rerunBatches()
  assert.equal(batches.length, 1)
  assert.equal(batches[0].row_count, 4)
  assert.deepEqual(lines().map(l => l.summary), ['A rerun replaced 4 rows it had added before'])
  assert.deepEqual(names().sort(), ['Ken', 'Radia'])
})

await ok('a restore puts the replaced rows back', async () => {
  const [batch] = rerunBatches()
  const back = await restoreRows(uid, batch.id)
  assert.ok('ok' in back, JSON.stringify(back))
  await idle(dest)
  assert.deepEqual(names().sort(), ['Ada', 'Barbara', 'Edsger', 'Grace', 'Ken', 'Radia'])
})

await ok('a restore of part of a batch never makes a line count fewer', async () => {
  answer(srcRows[1], ['Margaret'])
  const [batch] = rerunBatches()
  const first = lines().length
  assert.equal(lines().at(-1)!.summary, 'A rerun replaced 2 rows it had added before')
  const seq = db.prepare('SELECT seq FROM trash_rows WHERE item_id = ? ORDER BY seq LIMIT 1').pluck().get(batch.id)
  assert.ok('ok' in await restoreRows(uid, batch.id, [seq as number]))
  await idle(dest)
  answer(srcRows[1], ['Alan'])
  assert.equal(rerunBatches()[0].row_count, 2, 'the batch: the row left in it, and Margaret')
  assert.equal(lines()[first - 1].summary, 'A rerun replaced 2 rows it had added before', 'the first line stands')
  assert.equal(lines().at(-1)!.summary, 'A rerun replaced 1 row it had added before', 'after the restore, a new line')
})

await ok('at 0 days the rows are gone at once, and one History line counts them', () => {
  setTrashDays(uid, 0)
  const before = rerunBatches().length
  const kept = db.prepare('SELECT COUNT(*) FROM trash_rows').pluck().get()
  const count = lines().length
  answer(srcRows[1], ['Kurt'])
  answer(srcRows[1], ['Emmy'])
  assert.ok(!names().includes('Alan') && !names().includes('Kurt') && names().includes('Emmy'))
  assert.equal(rerunBatches().length, before, 'no new batch')
  assert.equal(db.prepare('SELECT COUNT(*) FROM trash_rows').pluck().get(), kept, 'nothing more kept')
  assert.equal(lines().length, count + 1, 'one line for both')
  const last = lines().at(-1)!
  assert.equal(last.summary, 'A rerun replaced 2 rows it had added before')
  assert.equal(JSON.parse(last.detail).trash_id, null)
})

done()

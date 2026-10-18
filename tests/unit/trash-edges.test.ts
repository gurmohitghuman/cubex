// The trash's edges (services/trash-*.ts), each a review finding pinned:
// list results bound for a sheet going to the trash are dropped (never added
// into it), and both sides' ➕ cells say they weren't added; a lookup whose
// auto-run paused while its sheet was in the trash starts again on restore;
// clean/formula/lookup columns queue rows restored to their old places; a
// restore that would leave cells out is refused; a grid delete in several
// calls keeps every column it saw; kept 0 days, a deleted sheet answers no
// trash id; auto-run's fence never stays above the last row after a restore.
import assert from 'node:assert/strict'
import sheetsMod from '../../server/src/services/trash-sheets'
import restoreMod from '../../server/src/services/trash-restore'
import restoreSheetMod from '../../server/src/services/trash-restore-sheet'
import storeMod from '../../server/src/lib/trash/store'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
const { trashSheet } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { restoreRows } = restoreMod as typeof import('../../server/src/services/trash-restore')
const { restoreSheetItem } = restoreSheetMod as typeof import('../../server/src/services/trash-restore-sheet')
const { setTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
const { db, uid, tid, ok, done, idle, fixture, rowsOf, item, del } = trashKit('trash-edges')

const cell = (rowId: string, col: string) =>
  JSON.parse((db.prepare('SELECT data FROM rows WHERE id = ?').get(rowId) as { data: string }).data)[col]
// A list run on `src` (its status column "People") with one result waiting to become rows in `dest`.
function listItem(src: string, dest: string, rowId: string) {
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,dest_sheet_id)
    VALUES (?,?,?,'{}','completed','People',?)`).run(run, src, uid, dest)
  db.prepare(`UPDATE rows SET data = json_set(data, '$.People', '➕ Adding 3 rows…') WHERE id = ?`).run(rowId)
  db.prepare(`INSERT INTO enrichment_list_items (id,user_id,run_id,source_sheet_id,source_row_id,dest_sheet_id,
    items_json,item_count) VALUES (?,?,?,?,?,?,'[]',3)`).run(uuid(), uid, run, src, rowId, dest)
}
const pendingFor = (sid: string) => db.prepare(`SELECT COUNT(*) FROM enrichment_list_items
  WHERE (source_sheet_id = ? OR dest_sheet_id = ?) AND status = 'pending'`).pluck().get(sid, sid) as number

await ok('list results bound for or from a sheet going to the trash are dropped, their ➕ cells say so', () => {
  const a = fixture(2, ['Email', 'Name', 'People']), d = fixture(1), e = fixture(1)
  listItem(a, d, `r0-${a}`)
  listItem(a, e, `r1-${a}`)
  assert.ok('ok' in trashSheet(uid, tid, d))
  assert.equal(pendingFor(d), 0, 'nothing waits to be added into the deleted sheet')
  assert.match(cell(`r0-${a}`, 'People'), /^❌ Rows not added/)
  assert.ok('ok' in trashSheet(uid, tid, a))
  assert.equal(pendingFor(a), 0)
  assert.match(cell(`r1-${a}`, 'People'), /^❌ Rows not added: this sheet was deleted/)
})

await ok('a lookup that paused while its sheet was in the trash starts again on restore', () => {
  const looked = fixture(2), looking = fixture(2)
  db.prepare(`INSERT INTO lookup_columns (id,user_id,sheet_id,column_name,source_column,other_sheet_id,
    match_column,match_mode,returns,fill_status) VALUES (?,?,?,'L','Email',?,'Email','equals','exists','done')`)
    .run(uuid(), uid, looking, looked)
  const entry = uuid()
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,watermark_row_index)
    VALUES (?,?,?,'L','lookup','["Email"]',2)`).run(entry, uid, looking)
  const out = trashSheet(uid, tid, looked)
  assert.ok('ok' in out)
  const broken = db.prepare('SELECT broken FROM lookup_columns WHERE sheet_id = ?').pluck().get(looking) as string
  db.prepare(`UPDATE autorun_columns SET paused_reason = 'setup', paused_message = ? WHERE id = ?`).run(broken, entry)
  assert.ok('ok' in restoreSheetItem(uid, out.ok.trashId!))
  assert.equal(db.prepare('SELECT paused_reason FROM autorun_columns WHERE id = ?').pluck().get(entry), null)
  assert.equal(db.prepare('SELECT broken FROM lookup_columns WHERE sheet_id = ?').pluck().get(looking), null)
})

await ok('rows restored to their old places are queued for clean, formula and lookup columns', async () => {
  const sid = fixture(4)
  const entry = uuid()
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,watermark_row_index)
    VALUES (?,?,?,'F','formula','["Name"]',6)`).run(entry, uid, sid)
  const out = del(sid, [2, 4])
  const back = await restoreRows(uid, out.trashId!)
  assert.ok('ok' in back && back.ok.place === 'old')
  await idle(sid)
  const queued = db.prepare('SELECT row_id FROM autorun_pending WHERE autorun_id = ? ORDER BY row_id').pluck()
    .all(entry) as string[]
  assert.deepEqual(queued, [`r1-${sid}`, `r2-${sid}`])
})

await ok("a restore that would leave cells out is refused; a later call's new column joins the batch", async () => {
  const sid = fixture(3, ['Email', 'Name', 'Extra'])
  const out = del(sid, [0])
  const full = Array.from({ length: 200 }, (_, i) => `C${i}`)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(full), sid)
  const refused = await restoreRows(uid, out.trashId!)
  assert.ok('fail' in refused && /room for 0 more/.test(refused.message), JSON.stringify(refused))
  assert.equal(item(out.trashId!)!.row_count, 1, 'nothing left the trash')
  db.prepare(`UPDATE sheets SET column_order = '["Email","Name","Late"]' WHERE id = ?`).run(sid)
  del(sid, [2], out.trashId!)
  assert.deepEqual(JSON.parse(item(out.trashId!)!.columns), ['Email', 'Name', 'Extra', 'Late'])
})

await ok('kept 0 days: a deleted sheet answers no trash id and goes for good', async () => {
  setTrashDays(uid, 0)
  try {
    const sid = fixture(2)
    const out = trashSheet(uid, tid, sid)
    assert.ok('ok' in out && out.ok.trashId === null)
    for (let i = 0; i < 200 && db.prepare('SELECT 1 FROM sheets WHERE id = ?').get(sid); i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    assert.equal(db.prepare('SELECT 1 FROM sheets WHERE id = ?').get(sid), undefined)
  } finally { setTrashDays(uid, 30) }
})

await ok("auto-run's fence never stays above the last row after a restore", async () => {
  const sid = fixture(5) // rows at 0, 2, 4, 6, 8
  const entry = uuid()
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,watermark_row_index)
    VALUES (?,?,?,'S','http','["Email"]',8)`).run(entry, uid, sid)
  const batch = del(sid, [6, 8]).trashId!
  const top = db.prepare('SELECT seq FROM trash_rows WHERE item_id = ? AND row_index = 8').pluck().get(batch) as number
  assert.ok('ok' in await restoreRows(uid, batch, [top]))
  del(sid, [8])
  assert.ok('ok' in await restoreRows(uid, batch))
  await idle(sid)
  const w = db.prepare('SELECT watermark_row_index FROM autorun_columns WHERE id = ?').pluck().get(entry)
  assert.equal(w, Math.max(...rowsOf(sid).map(r => r.row_index)))
})

done()

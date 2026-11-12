// What a column delete or restore refuses (migration 054), with its words, and what goes for good with the
// trash: a restore refused while a run is active on the sheet, while it is busy, at the column limit, while its
// sheet is in the trash, and with seqs; a sheet's purge takes its column items; and a delete refused while a
// strip of the same name is still pending (it would never fill its item), before anything changes.
import assert from 'node:assert/strict'
import busyMod from '../../server/src/lib/sheet-busy'
import sheetsMod from '../../server/src/services/trash-sheets'
import purgeMod from '../../server/src/services/trash-purge'
import readMod from '../../server/src/services/trash-read'
import restoreRowsMod from '../../server/src/services/trash-restore'
import deleteMod from '../../server/src/services/column-delete'
import stripMod from '../../server/src/lib/column-purge'
import constMod from '../../server/src/lib/constants'
import { v4 as uuid } from 'uuid'
import { columnTrashKit } from './column-trash-kit'
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { trashSheet } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')
const { getTrashEntry } = readMod as typeof import('../../server/src/services/trash-read')
const { restoreRows } = restoreRowsMod as typeof import('../../server/src/services/trash-restore')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { forgetPurge, recordPurge } = stripMod as typeof import('../../server/src/lib/column-purge')
const { MAX_COLUMNS_PER_SHEET } = constMod as typeof import('../../server/src/lib/constants')
const k = columnTrashKit('column-trash-refusals')
const { db, uid, tid, ok, done, sheet, order, cells, item, stored, del, restoreOne } = k

const leads = () => sheet(['Email', 'Notes', 'Name'], [
  { Email: 'a@x.co', Notes: 'first', Name: 'A' }, { Email: 'b@x.co', Notes: '', Name: 'B' },
  { Email: 'c@x.co', Name: 'C' }, { Email: 'd@x.co', Notes: { deep: [1, 2] }, Name: 'D' },
  { Email: 'e@x.co', Notes: 42, Name: 'E' },
])

await ok('refusals: a run on the sheet, a busy sheet, the column limit, its sheet in the trash, seqs', async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Name')`).run(run, sid, uid)
  const active = await restoreOne(id)
  assert.equal(active.fail, 'conflict')
  assert.equal(active.error, 'Cannot restore a column while a run is active on this sheet. Stop or finish the run '
    + 'first.')
  assert.deepEqual(active.blocking_run, { id: run, kind: 'http', column: 'Name', paused: false })
  db.prepare(`UPDATE http_runs SET status = 'completed' WHERE id = ?`).run(run)
  let release!: () => void
  const held = withSheetBusy(sid, 'sorting', () => new Promise<void>(r => { release = r }))
  const busy = await restoreOne(id)
  assert.deepEqual([busy.fail, busy.error, busy.busy], ['conflict', 'This sheet is busy sorting. Try again when that '
    + 'finishes.', true])
  release(); await held
  assert.equal(item(id)!.state, 'kept', 'a refused restore leaves the item as it was')
  const full = Array.from({ length: MAX_COLUMNS_PER_SHEET }, (_, i) => `C${i}`)
  const saved = order(sid)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(full), sid)
  const cap = await restoreOne(id)
  assert.deepEqual([cap.fail, cap.error], ['bad_request', `The sheet has ${MAX_COLUMNS_PER_SHEET} columns, the most `
    + 'it can hold. Delete a column, then restore "Notes".'])
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(saved), sid)
  const picked = await restoreRows(uid, id, [1])
  assert.deepEqual(picked, { fail: 'bad_request', message: 'A column comes back whole: restore it without seqs.' })
  const other = leads()
  assert.ok('ok' in trashSheet(uid, tid, other))
  const gone = sheet(['X', 'Y'], [{ X: 1, Y: 2 }])
  const inTrash = (await del(gone, 'Y'))!
  const sheetItem = trashSheet(uid, tid, gone)
  assert.ok('ok' in sheetItem)
  const waits = await restoreOne(inTrash)
  const sheetName = db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(gone)
  assert.deepEqual([waits.fail, waits.error], ['conflict', `Its sheet "${sheetName}" is in the trash. Restore the `
    + 'sheet first.'])
  assert.equal(getTrashEntry(uid, inTrash)!.blocked,
    `Its sheet "${sheetName}" is in the trash: restore the sheet first.`)
  assert.ok((await restoreOne(id)).restored, 'once free, it restores')
})

await ok("a sheet's purge takes its column items and their cells", async () => {
  const sid = leads()
  const id = (await del(sid, 'Notes'))!
  assert.equal(item(id)!.state, 'kept')
  assert.equal(stored(id).length, 3)
  const out = trashSheet(uid, tid, sid)
  assert.ok('ok' in out)
  const sheetItem = db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND kind = 'sheet'`).pluck().get(sid) as
    number
  purgeTrashItems(uid, [sheetItem])
  for (let i = 0; i < 300 && item(sheetItem); i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(item(sheetItem), undefined)
  assert.equal(item(id), undefined)
  assert.equal(stored(id).length, 0)
  const lone = leads()
  const alone = (await del(lone, 'Notes'))!
  assert.equal(stored(alone).length, 3)
  purgeTrashItems(uid, [alone])
  for (let i = 0; i < 300 && item(alone); i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(item(alone), undefined)
  assert.equal(stored(alone).length, 0)
  assert.deepEqual(order(lone), ['Email', 'Name'])
})

await ok('a strip of the same name still pending: the delete is refused, and nothing changes', async () => {
  const sid = leads()
  // As a change cut short leaves it until the boot resume finishes it.
  recordPurge(sid, uid, 'Notes')
  const items = () => db.prepare('SELECT COUNT(*) FROM trash_items WHERE sheet_id = ?').pluck().get(sid)
  const out = await deleteSheetColumn(sid, uid, 'Notes', { bumpDataVersion: true })
  assert.deepEqual(out, { fail: 'busy', error: '"Notes" can\'t be deleted yet: an earlier change is still removing '
    + 'a column of that name from the rows. Try again in a moment.' })
  assert.deepEqual(order(sid), ['Email', 'Notes', 'Name'])
  assert.deepEqual(cells(sid, 'Notes'), ['first', '', null, '{"deep":[1,2]}', 42])
  assert.equal(items(), 0, 'no item left moving')
  assert.equal(db.prepare('SELECT trash_id FROM column_purges WHERE sheet_id = ?').pluck().get(sid), null)
  forgetPurge(sid, 'Notes')
  const id = (await del(sid, 'Notes'))!
  assert.deepEqual([item(id)!.state, stored(id).length], ['kept', 3], 'once it is done, the delete goes through')
  // A second strip record for a trash item fails loudly rather than leaving that item to wait.
  recordPurge(sid, uid, 'Email', null)
  assert.throws(() => recordPurge(sid, uid, 'Email', id), /UNIQUE/)
})

done()

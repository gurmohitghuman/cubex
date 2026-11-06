// What a restore starts again (trash-restore-sheet.ts) waits for the request
// that restored: a fill parked while its sheet was in the trash goes on after
// it, so a batch of the sheet's rows restored next in the same request isn't
// refused as busy. And every lookup into the restored sheet whose fill failed
// while it was in the trash looks up again, two on one sheet one after another.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
import sheetsMod from '../../server/src/services/trash-sheets'
import restoreMod from '../../server/src/services/trash-restore-sheet'
import actionsMod from '../../server/src/services/trash-actions'
import lookupMod from '../../server/src/services/lookup-column'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import recMod from '../../server/src/lib/lookup-columns'
import busyMod from '../../server/src/lib/sheet-busy'
const { trashSheet, trashTable } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { restoreSheetItem } = restoreMod as typeof import('../../server/src/services/trash-restore-sheet')
const { restoreFromTrash } = actionsMod as typeof import('../../server/src/services/trash-actions')
const { startLookupColumn } = lookupMod as typeof import('../../server/src/services/lookup-column')
const { waitForDerivedFill, derivedFillWait, resumeDerivedFills } =
  fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind, LOOKUP_FILLING } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { lookupColumnFor } = recMod as typeof import('../../server/src/lib/lookup-columns')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { db, uid, ok, done, fixture, rowsOf, idle, del } = trashKit('trash-restore-refill')
console.error = () => {}

type Place = { table: string; sid: string }
// A sheet in a table of its own, with a spare sheet beside it so it can go alone.
const place = (): Place => {
  const table = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(table, uid, `T_${table.slice(0, 8)}`)
  const sid = fixture(3, ['Email', 'Name'], table)
  fixture(1, ['Email', 'Name'], table)
  return { table, sid }
}
const trash = (how: 'sheet' | 'table', p: Place): number => {
  const out = how === 'sheet' ? trashSheet(uid, p.table, p.sid) : trashTable(uid, p.table)
  assert.ok('ok' in out && out.ok.trashId, JSON.stringify(out))
  return out.ok.trashId!
}
const cells = (sid: string, col: string) => rowsOf(sid).map(r => JSON.parse(r.data)[col] as string | undefined)
const statusOf = (sid: string, col: string) => lookupColumnFor(sid, uid, col)?.fill_status
const IN_TRASH = 'Waits for its sheet to come back from the trash.'
const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`Timed out waiting until ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
const lookup = async (sid: string, other: string, column: string, returns: string) => {
  const out = await startLookupColumn(uid, sid, { column, otherSheetId: other, sourceColumn: 'Email',
    matchColumn: 'Email', returns })
  assert.ok('ok' in out, JSON.stringify(out))
  await waitForDerivedFill(lookupKind, out.ok.id, 15_000)
  await idle(sid)
  assert.equal(statusOf(sid, column), 'done')
  return out.ok.id
}
// As a restart finds a lookup: filling from the top, its cells empty.
const refilling = (sid: string) => {
  db.prepare("UPDATE lookup_columns SET fill_status = 'filling', fill_cursor = 0 WHERE sheet_id = ?").run(sid)
  db.prepare("UPDATE rows SET data = json_remove(data, '$.Found', '$.Count') WHERE sheet_id = ?").run(sid)
}

for (const how of ['sheet', 'table'] as const) {
  await ok(`restoring a ${how} with a parked fill, then a batch of the sheet's rows in one request, restores both`,
    async () => {
      const p = place()
      const id = await lookup(p.sid, place().sid, 'Found', 'exists')
      const rows = del(p.sid, [2])
      assert.ok(rows.trashId, 'a batch of rows went to the trash')
      refilling(p.sid)
      const item = trash(how, p)
      resumeDerivedFills(lookupKind)
      await until('the fill is parked', () => derivedFillWait(id) === IN_TRASH)
      await idle(p.sid)
      // In the order the Trash page sends them: the sheet (or table) first, then its rows.
      const out = await restoreFromTrash(uid, [item, rows.trashId!])
      assert.ok(out[0].restored, JSON.stringify(out[0]))
      assert.ok(out[1].restored, `the rows restore isn't refused: ${JSON.stringify(out[1])}`)
      await until('the fill is done', () => statusOf(p.sid, 'Found') === 'done')
      assert.equal(derivedFillWait(id), null)
      assert.deepEqual(cells(p.sid, 'Found'), ['Yes', 'Yes', 'Yes'])
    })
}

await ok('two lookups on one sheet that failed while the sheet they read was in the trash both look up again',
  async () => {
    const a = place().sid
    const other = place()
    await lookup(a, other.sid, 'Found', 'exists')
    await lookup(a, other.sid, 'Count', 'count')
    const item = trash('sheet', other)
    // Both fills go on while the sheet they read is in the trash, and fail on it.
    refilling(a)
    resumeDerivedFills(lookupKind)
    await until('both fail', () => statusOf(a, 'Found') === 'failed' && statusOf(a, 'Count') === 'failed')
    await idle(a)
    assert.match(lookupColumnFor(a, uid, 'Count')?.error_message ?? '', /it looks in is in the trash/)
    const r = restoreSheetItem(uid, item)
    assert.ok('ok' in r, JSON.stringify(r))
    assert.equal(sheetBusyWith(a), LOOKUP_FILLING, 'the first takes its sheet in the restore')
    await until('both are done', () => statusOf(a, 'Found') === 'done' && statusOf(a, 'Count') === 'done')
    assert.deepEqual(cells(a, 'Found'), ['Yes', 'Yes', 'Yes'])
    assert.ok(cells(a, 'Count').every(c => c !== undefined && c !== ''), JSON.stringify(cells(a, 'Count')))
  })

done()

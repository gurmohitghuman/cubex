// Derived columns write nothing into a sheet in the trash, deleted alone or
// with its table: auto-run following a clean column's source (an edit queued
// the row, then the sheet went before the follow-up ran), and a lookup fill
// that waited with its sheet free (the other sheet was sorting) while the
// sheet went to the trash. Both go on once the sheet is restored.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
import sheetsMod from '../../server/src/services/trash-sheets'
import restoreMod from '../../server/src/services/trash-restore-sheet'
import cleanMod from '../../server/src/services/clean-column'
import cleanFillMod from '../../server/src/services/clean-fill'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
import markMod from '../../server/src/lib/autorun-mark'
import lookupMod from '../../server/src/services/lookup-column'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import recMod from '../../server/src/lib/lookup-columns'
import busyMod from '../../server/src/lib/sheet-busy'
const { trashSheet, trashTable } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { restoreSheetItem } = restoreMod as typeof import('../../server/src/services/trash-restore-sheet')
const { startCleanColumn } = cleanMod as typeof import('../../server/src/services/clean-column')
const { waitForCleanFill } = cleanFillMod as typeof import('../../server/src/services/clean-fill')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { entryFor } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { markAutorunEdits } = markMod as typeof import('../../server/src/lib/autorun-mark')
const { startLookupColumn } = lookupMod as typeof import('../../server/src/services/lookup-column')
const { waitForDerivedFill, derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { lookupColumnFor } = recMod as typeof import('../../server/src/lib/lookup-columns')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { db, uid, ok, done, fixture, rowsOf, idle } = trashKit('trash-derived-writes')
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
const HOWS = [['sheet', 'deleted alone'], ['table', 'deleted with its table']] as const
const trash = (how: 'sheet' | 'table', p: Place): number => {
  const out = how === 'sheet' ? trashSheet(uid, p.table, p.sid) : trashTable(uid, p.table)
  assert.ok('ok' in out && out.ok.trashId, JSON.stringify(out))
  return out.ok.trashId!
}
const restore = (id: number) => { const r = restoreSheetItem(uid, id); assert.ok('ok' in r, JSON.stringify(r)) }
const cells = (sid: string, col: string) => rowsOf(sid).map(r => JSON.parse(r.data)[col] as string | undefined)
const version = (sid: string) => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(sid)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

for (const [how, words] of HOWS) {
  await ok(`a clean column's auto-run writes nothing into a sheet ${words}, and catches up once it's back`,
    async () => {
      const p = place()
      const started = await startCleanColumn(uid, p.sid, { source: 'Name', cleaner: 'lowercase' })
      assert.ok('ok' in started, JSON.stringify(started))
      await waitForCleanFill(started.ok.id, 5_000)
      await idle(p.sid)
      assert.deepEqual(cells(p.sid, 'Name (clean)'), ['n0', 'n1', 'n2'])
      const entry = entryFor(p.sid, uid, 'Name (clean)')!
      const row = rowsOf(p.sid)[1]
      // An edit queues the row for the follow-up; the sheet goes before it runs.
      db.prepare(`UPDATE rows SET data = json_set(data, '$.Name', 'EDITED') WHERE id = ?`).run(row.id)
      markAutorunEdits(p.sid, uid, [{ column: 'Name', rowId: row.id }])
      const id = trash(how, p)
      const v = version(p.sid)
      await derivedFollowTick(entry)
      assert.deepEqual(cells(p.sid, 'Name (clean)'), ['n0', 'n1', 'n2'], 'nothing was written')
      assert.equal(version(p.sid), v)
      restore(id)
      await derivedFollowTick(entryFor(p.sid, uid, 'Name (clean)')!)
      assert.deepEqual(cells(p.sid, 'Name (clean)'), ['n0', 'edited', 'n2'], 'the queued row is cleaned')
    })

  await ok(`a lookup fill that waited writes nothing into a sheet ${words} meanwhile, and ends once it's back`,
    async () => {
      const p = place()
      const other = place().sid
      let release!: () => void
      const held = new Promise<void>(r => { release = r })
      const hold = withSheetBusy(other, 'sorting', () => held)
      const out = await startLookupColumn(uid, p.sid, { column: 'Found', otherSheetId: other,
        sourceColumn: 'Email', matchColumn: 'Email', returns: 'exists' })
      assert.ok('ok' in out, JSON.stringify(out))
      await sleep(300)
      await idle(p.sid)
      assert.match(derivedFillWait(out.ok.id) ?? '', /to finish sorting/)
      const id = trash(how, p)
      release(); await hold
      await sleep(1_500)
      await idle(p.sid)
      assert.deepEqual(cells(p.sid, 'Found'), [undefined, undefined, undefined], 'nothing was written')
      assert.equal(lookupColumnFor(p.sid, uid, 'Found')?.fill_status, 'filling')
      assert.equal(derivedFillWait(out.ok.id), 'Waits for its sheet to come back from the trash.')
      restore(id)
      await waitForDerivedFill(lookupKind, out.ok.id, 30_000)
      assert.equal(lookupColumnFor(p.sid, uid, 'Found')?.fill_status, 'done')
      assert.deepEqual(cells(p.sid, 'Found'), ['Yes', 'Yes', 'Yes'])
    })
}

done()

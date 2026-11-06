// Shared by the tests of what a restore starts again (trash-restore-refill,
// trash-restore-lookups): sheets in tables of their own, lookups between them,
// lookups that failed while the sheet they read was in the trash, and waits.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { trashKit } from './trash-kit'
import sheetsMod from '../../server/src/services/trash-sheets'
import lookupMod from '../../server/src/services/lookup-column'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import recMod from '../../server/src/lib/lookup-columns'
const { trashSheet, trashTable } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { startLookupColumn } = lookupMod as typeof import('../../server/src/services/lookup-column')
const { waitForDerivedFill, resumeDerivedFills } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { lookupColumnFor } = recMod as typeof import('../../server/src/lib/lookup-columns')

export type Place = { table: string; sid: string }
export const IN_TRASH = 'Waits for its sheet to come back from the trash.'

export function refillKit(name: string) {
  const kit = trashKit(name)
  const { db, uid, fixture, rowsOf, idle } = kit
  // A sheet of 3 rows in a table of its own, with a spare sheet beside it so it can go alone.
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
  const until = async (what: string, cond: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; !cond();) {
      if (Date.now() > end) throw new Error(`Timed out waiting until ${what}`)
      await new Promise(r => setTimeout(r, 10))
    }
  }
  // A lookup from sid's Email into other's Email, filled.
  const lookup = async (sid: string, other: string, column: string, returns: string, returnColumn?: string) => {
    const out = await startLookupColumn(uid, sid, { column, otherSheetId: other, sourceColumn: 'Email',
      matchColumn: 'Email', returns, returnColumn })
    assert.ok('ok' in out, JSON.stringify(out))
    await waitForDerivedFill(lookupKind, out.ok.id, 15_000)
    await idle(sid)
    assert.equal(statusOf(sid, column), 'done')
    return out.ok.id
  }
  const lookupsOn = (sid: string) =>
    db.prepare('SELECT column_name FROM lookup_columns WHERE sheet_id = ?').pluck().all(sid) as string[]
  // As a restart finds the sheet's lookups: filling from the top (wipe: their cells empty).
  const refilling = (sid: string, wipe = true) => {
    db.prepare("UPDATE lookup_columns SET fill_status = 'filling', fill_cursor = 0 WHERE sheet_id = ?").run(sid)
    if (!wipe) return
    for (const c of lookupsOn(sid)) {
      db.prepare('UPDATE rows SET data = json_remove(data, ?) WHERE sheet_id = ?').run(`$."${c}"`, sid)
    }
  }
  // The sheet the lookups on sid read goes to the trash, and their fills go on
  // meanwhile and fail on it. Returns its trash item.
  const failedOnTrash = async (sid: string, other: Place, wipe = true): Promise<number> => {
    const item = trash('sheet', other)
    refilling(sid, wipe)
    resumeDerivedFills(lookupKind)
    await until('they fail', () => lookupsOn(sid).every(c => statusOf(sid, c) === 'failed'))
    await idle(sid)
    for (const c of lookupsOn(sid)) {
      assert.match(lookupColumnFor(sid, uid, c)?.error_message ?? '', /it looks in is in the trash\.$/)
    }
    return item
  }
  return { ...kit, place, trash, cells, statusOf, until, lookup, refilling, failedOnTrash }
}

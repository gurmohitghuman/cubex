// A transform_column cursor goes on only while its pass is open, from exactly where that pass last stopped
// (services/column-transform-passes.ts). Refused, writing nothing: the call that ended a pass sent again; an
// older cursor of a finished pass; the cursor of a pass restart: true discarded (naming the open pass's cursor
// while there is one; nothing skipped), the same call stopped at the same row too (each pass has its own cursor,
// and once the pass ends both are over, the same call's pass on another sheet notwithstanding); the kept cursor
// on the old name after a rename (no column made under it; a template naming T there is refused naming T);
// the kept cursor after its column was deleted for good and added back; a cursor edited ahead of the pass, or a
// malformed one, while the pass is open (naming its cursor); the pass's cursor with a source column renamed
// since (its arguments differ), and the same call naming the old name (the template's column is gone: refused
// naming it, as a template naming any column the sheet doesn't have is, and a source or where column). A call
// its time budget stops before writing a row answers a cursor its open pass holds: it goes on, and every
// matching row is written once (a call without cursor then: transform-pass-zero.test.ts).
// Over 200 lines: one fixture and the cases of the cursor rule, read top to bottom.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/api-v1-constants'
import renameMod from '../../server/src/services/column-rename'
import deleteMod from '../../server/src/services/column-delete'
import addMod from '../../server/src/services/column-add'
import storeMod from '../../server/src/lib/trash/store'
import { transformPageFault } from './transform-page-fault'
import { notOpen, otherArgs, otherColumn, unfinished } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { TRANSFORM_MAX_CALL_MS } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { addSheetColumn } = addMod as typeof import('../../server/src/services/column-add')
const { getTrashDays, setTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
type Params = import('../../server/src/services/column-transform').TransformParams

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const fault = transformPageFault(db)
const realNow = Date.now
let shiftMs = 0
Date.now = () => realNow() + shiftMs
// A call its time budget stops after its first page: that page's read moves the clock past the budget.
const prepare = db.prepare.bind(db)
let shiftOnRead = false
db.prepare = ((sql: string) => {
  const stmt = prepare(sql)
  if (!sql.startsWith('SELECT rowid AS rid, data FROM rows')) return stmt
  const all = stmt.all.bind(stmt)
  Object.assign(stmt, { all: (...a: unknown[]) => {
    if (shiftOnRead) { shiftOnRead = false; shiftMs += TRANSFORM_MAX_CALL_MS }
    return all(...a)
  } })
  return stmt
}) as typeof db.prepare

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 650
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
let made = 0
function sheet(rows = ROWS, s = (i: number) => `s${i}`): string {
  const id = uuid()
  addSheet.run(id, tid, uid, `S${made}`, made++, JSON.stringify(['S', 'T']))
  db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(uuid(), id, uid, i, JSON.stringify({ S: s(i), T: `t${i}` }))
  })()
  return id
}
// Reads its own target: a row the operation reached twice ends "-x-x".
const call = (sheetId: string, t = 'T'): Params => ({ sheetId, operation: 'template', template: `{{${t}}}-x`,
  targetColumn: t })
const cells = (id: string) => db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id = ?').pluck().get(id)
const ending = (id: string, t: string, glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, ?) GLOB ?`).pluck().get(id, `$."${t}"`, glob) as number
const columns = (id: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(id) as string) as string[]
// The n-th row written fails: 251, its second page.
async function stopped(p: Params, n = 251) {
  fault.arm(n)
  try {
    const out = await transformColumn(uid, p)
    assert.ok('stopped' in out, JSON.stringify(out))
    return out.stopped.next_cursor
  } finally { fault.disarm() }
}
const missing = (error: string) => ({ fail: 'invalid', error })
async function refused(p: Params, answer: object) {
  const before = cells(p.sheetId)
  assert.deepEqual(await transformColumn(uid, p), answer)
  assert.equal(cells(p.sheetId), before, 'nothing written')
}

async function main() {
  await check('the call that ended a pass, sent again with its cursor, and an older cursor of that pass, are '
    + 'refused', async () => {
    const sid = sheet()
    const first = await stopped(call(sid))
    const second = await stopped({ ...call(sid), cursor: first })
    assert.ok('ok' in await transformColumn(uid, { ...call(sid), cursor: second }))
    await refused({ ...call(sid), cursor: second }, notOpen)
    await refused({ ...call(sid), cursor: first }, notOpen)
    assert.equal(ending(sid, 'T', 't*-x'), ROWS)
    assert.equal(ending(sid, 'T', '*-x-x'), 0)
  })

  await check('the cursor of a pass restart: true discarded is refused, naming the open pass\'s, and once that '
    + 'one ends, refused as over; no row is skipped', async () => {
    const sid = sheet()
    const p = (n: string): Params => ({ sheetId: sid, operation: 'template', template: `{{S}}-${n}`,
      targetColumn: 'T' })
    const old = await stopped(p('x'))
    const fresh = await stopped({ ...p('y'), restart: true })
    await refused({ ...p('x'), cursor: old }, unfinished('T', 250, fresh))
    await refused({ ...p('y'), cursor: old }, unfinished('T', 250, fresh))
    assert.ok('ok' in await transformColumn(uid, { ...p('y'), cursor: fresh }))
    await refused({ ...p('y'), cursor: old }, notOpen)
    assert.equal(ending(sid, 'T', 's*-y'), ROWS, 'every row has the restarted pass\'s value')
  })

  await check('the same call restarted and stopped at the same row: the discarded pass\'s cursor is another one, '
    + 'refused naming the new; once that pass ends, both are over, even with the same call open on another sheet',
  async () => {
    const sid = sheet(), elsewhere = sheet()
    const p = (id: string): Params => ({ sheetId: id, operation: 'template', template: '{{S}}-z', targetColumn: 'T' })
    const old = await stopped(p(sid))
    const fresh = await stopped({ ...p(sid), restart: true })
    assert.notEqual(fresh, old, 'each pass its own cursor')
    await refused({ ...p(sid), cursor: old }, unfinished('T', 250, fresh))
    const other = await stopped(p(elsewhere))
    assert.ok('ok' in await transformColumn(uid, { ...p(sid), cursor: fresh }))
    await refused({ ...p(sid), cursor: fresh }, notOpen)
    await refused({ ...p(sid), cursor: old }, notOpen)
    assert.equal(ending(sid, 'T', 's*-z'), ROWS)
    assert.ok('ok' in await transformColumn(uid, { ...p(elsewhere), cursor: other }))
  })

  await check('T renamed T2: the kept cursor on T is refused and makes no column T; T2\'s pass goes on with it',
    async () => {
      const sid = sheet()
      const cursor = await stopped(call(sid))
      assert.deepEqual(await renameSheetColumn(sid, uid, 'T', 'T2'), { ok: true, newName: 'T2' })
      await refused({ ...call(sid), cursor }, missing('Template column "T" not found.'))
      await refused({ sheetId: sid, operation: 'upper', sourceColumn: 'S', targetColumn: 'T', cursor },
        otherColumn('T2', 'T'))
      assert.deepEqual(columns(sid), ['S', 'T2'])
      assert.deepEqual(await transformColumn(uid, { ...call(sid, 'T2'), cursor }),
        { ok: { updated: ROWS - 250, created_column: null } })
      assert.equal(ending(sid, 'T2', 't*-x'), ROWS)
      assert.equal(ending(sid, 'T2', '*-x-x'), 0)
    })

  await check('its column deleted for good and added back: the kept cursor is refused', async () => {
    const sid = sheet()
    const cursor = await stopped(call(sid))
    const days = getTrashDays(uid)
    setTrashDays(uid, 0)
    try {
      const out = await deleteSheetColumn(sid, uid, 'T')
      assert.ok('ok' in out && out.trashId === null, JSON.stringify(out))
    } finally { setTrashDays(uid, days) }
    assert.ok('ok' in addSheetColumn(sid, uid, 'T'))
    await refused({ ...call(sid), cursor }, notOpen)
  })

  await check('while the pass is open, a cursor edited ahead of it or a malformed one is refused naming its '
    + 'cursor; a source column renamed since makes the arguments differ', async () => {
    const sid = sheet()
    const cursor = await stopped(call(sid))
    const ahead = cursor.replace(/^(\d+):249:/, '$1:649:')
    assert.notEqual(ahead, cursor)
    await refused({ ...call(sid), cursor: ahead }, unfinished('T', 250, cursor))
    for (const bad of ['abc', '1:2:3', '']) await refused({ ...call(sid), cursor: bad }, unfinished('T', 250, cursor))
    const src = sheet()
    const p: Params = { sheetId: src, operation: 'template', template: '{{S}}-x', targetColumn: 'T' }
    const kept = await stopped(p)
    assert.deepEqual(await renameSheetColumn(src, uid, 'S', 'S2'), { ok: true, newName: 'S2' })
    await refused({ ...p, template: '{{S2}}-x', cursor: kept }, otherArgs('T'))
    await refused({ ...p, template: '{{S2}}-x', cursor: 'abc' }, unfinished('T', 250, kept))
    await refused({ ...p, cursor: kept }, missing('Template column "S" not found.'))
    assert.equal(ending(src, 'T', '-x'), 0, 'no row written from the missing column')
    await refused({ ...p, template: '{{Nope}} {{S2}} {{ Gone }}', targetColumn: 'U' },
      missing('Template columns "Nope", "Gone" not found.'))
    assert.deepEqual(columns(src), ['S2', 'T'])
    await refused({ sheetId: src, operation: 'upper', sourceColumn: 'S', targetColumn: 'T', cursor: kept },
      missing('Source column "S" not found.'))
    await refused({ ...p, template: '{{S2}}-x', where: [{ column: 'S', operator: 'not_empty' }], cursor: kept },
      missing('Unknown column(s): S'))
  })

  await check('a call its time budget stops before writing a row answers a cursor its open pass holds: another '
    + 'cursor is refused naming it, and going on writes every matching row once', async () => {
    const BIG = 5000
    const sid = sheet(BIG, i => (i >= 4000 ? `late${i}` : `s${i}`))
    const p: Params = { ...call(sid), where: [{ column: 'S', operator: 'starts_with', value: 'late' }] }
    shiftOnRead = true
    const first = await transformColumn(uid, p)
    assert.ok('ok' in first && first.ok.updated === 0 && first.ok.next_cursor, JSON.stringify(first))
    await refused({ ...p, cursor: 'abc' }, unfinished('T', 0, first.ok.next_cursor))
    let written = 0
    for (let cursor: string | undefined = first.ok.next_cursor; cursor;) {
      const out = await transformColumn(uid, { ...p, cursor })
      assert.ok('ok' in out, JSON.stringify(out))
      written += out.ok.updated
      cursor = out.ok.next_cursor
    }
    assert.equal(written, 1000)
    assert.equal(ending(sid, 'T', 't*-x'), 1000)
    assert.equal(ending(sid, 'T', '*-x-x'), 0)
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-pass-cursor assertions passed.')
    process.exit(0)
  })

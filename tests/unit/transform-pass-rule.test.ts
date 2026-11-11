// One unfinished transform_column pass per column (services/column-transform-passes.ts).
// After a pass stopped at 250 rows, every call writing that column without its
// cursor is refused and writes nothing: the same call with its where items
// swapped, with {{ T }} for {{T}}, or another operation. The pass follows a
// rename of its column: the call on the new name is refused naming the cursor,
// and going on with it ends every row exactly once. A cursor the pass answered
// before its last stop is refused, naming the newer one. A column deleted and
// added back empty keeps no record: the call without cursor runs from the top.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import renameMod from '../../server/src/services/column-rename'
import deleteMod from '../../server/src/services/column-delete'
import addMod from '../../server/src/services/column-add'
import { transformPageFault } from './transform-page-fault'
import { unfinished } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { addSheetColumn } = addMod as typeof import('../../server/src/services/column-add')
type Params = import('../../server/src/services/column-transform').TransformParams

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const fault = transformPageFault(db)

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 650
const uid = uuid(), tid = uuid(), sid = uuid(), redo = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
for (const [n, id] of [sid, redo].entries()) {
  addSheet.run(id, tid, uid, `S${n}`, n, JSON.stringify(['S', 'T']))
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) insert.run(uuid(), id, uid, i, JSON.stringify({ S: `s${i}`, T: `t${i}` }))
  })()
}
// Reads its own target: a row the operation reached twice ends "-x-x".
const where = (t: string) =>
  [{ column: t, operator: 'not_empty' }, { column: 'S', operator: 'starts_with', value: 's' }]
const call = (sheetId: string, t: string): Params => ({ sheetId, operation: 'template', template: `{{${t}}}-x`,
  targetColumn: t, where: where(t) as Params['where'] })
const cells = (id: string) => db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id = ?').pluck().get(id)
const ending = (id: string, t: string, glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, ?) GLOB ?`).pluck().get(id, `$."${t}"`, glob) as number
const records = (id: string) => db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(id)
// The n-th row written fails: 251, its second page; 501, its third.
async function stoppedAt(p: Params, n = 251) {
  fault.arm(n)
  try {
    const out = await transformColumn(uid, p)
    assert.ok('stopped' in out, JSON.stringify(out))
    return out.stopped
  } finally { fault.disarm() }
}
// Refused in the words naming the pass's cursor, with nothing written.
async function refused(p: Params, column: string, rows: number, cursor: string, label: string) {
  const before = cells(p.sheetId)
  assert.deepEqual(await transformColumn(uid, p), unfinished(column, rows, cursor), label)
  assert.equal(cells(p.sheetId), before, `${label}: nothing written`)
}

async function main() {
  let cursor = ''
  await check('after a stop at 250 rows, the same call with its where items swapped, with {{ T }}-x, or another '
    + 'operation on that column is refused and writes nothing', async () => {
    cursor = (await stoppedAt(call(sid, 'T'))).next_cursor
    const p = call(sid, 'T')
    await refused({ ...p, where: [...p.where!].reverse() }, 'T', 250, cursor, 'where swapped')
    await refused({ ...p, template: '{{ T }}-x' }, 'T', 250, cursor, '{{ T }}')
    await refused({ sheetId: sid, operation: 'upper', sourceColumn: 'S', targetColumn: 'T' }, 'T', 250, cursor,
      'upper')
    assert.equal(ending(sid, 'T', 't*-x'), 250)
  })

  await check('renamed between the stop and the retry: the call on the new name is refused naming the cursor, and '
    + 'going on with it ends every row exactly once', async () => {
    assert.deepEqual(await renameSheetColumn(sid, uid, 'T', 'T2'), { ok: true, newName: 'T2' })
    await refused(call(sid, 'T2'), 'T2', 250, cursor, 'the new name')
    assert.deepEqual(await transformColumn(uid, { ...call(sid, 'T2'), cursor }),
      { ok: { updated: ROWS - 250, created_column: null } })
    assert.equal(ending(sid, 'T2', 't*-x'), ROWS)
    assert.equal(ending(sid, 'T2', '*-x-x'), 0)
    assert.equal(records(sid), 0)
  })

  await check('a cursor the pass answered before its last stop is refused, naming the newer one', async () => {
    const p = { ...call(sid, 'T2'), template: '{{T2}}-y' }
    const first = await stoppedAt(p)
    const second = await stoppedAt({ ...p, cursor: first.next_cursor })
    assert.equal(second.rows_done, 500)
    await refused({ ...p, cursor: first.next_cursor }, 'T2', 500, second.next_cursor, 'the earlier cursor')
    assert.ok('ok' in await transformColumn(uid, { ...p, cursor: second.next_cursor }))
    assert.equal(ending(sid, 'T2', '*-x-y'), ROWS)
  })

  await check('deleted and added back empty: no record is left, and the call without cursor runs from the top',
    async () => {
      const p = { sheetId: redo, operation: 'upper' as const, sourceColumn: 'S', targetColumn: 'U' }
      await stoppedAt(p)
      assert.equal(records(redo), 1)
      assert.deepEqual(await deleteSheetColumn(redo, uid, 'U'), { ok: true })
      assert.equal(records(redo), 0, 'it went with the column')
      assert.ok('ok' in addSheetColumn(redo, uid, 'U'))
      assert.deepEqual(await transformColumn(uid, p), { ok: { updated: ROWS, created_column: null } })
      assert.equal(ending(redo, 'U', 'S*'), ROWS)
      assert.equal(records(redo), 0)
    })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-pass-rule assertions passed.')
    process.exit(0)
  })

// A copy of a sheet's values while a transform_column pass into a column it copies is unfinished
// (services/column-transform-pass-moves.ts, sheet-copy*.ts): the copy gets a pass of its own, with a new pass
// id, at the copy's row matching where the original had reached (the source's rows sit at 0, 3, 6… and the copy
// renumbers them 0, 1, 2…, in several slices). The copy's call without cursor is refused naming the copy's own
// cursor; the original's cursor is refused there, and the copy's on the source; going on in each ends every row
// once. A copy leaving that column out gets no pass.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import copyMod from '../../server/src/services/sheet-copy'
import { transformPageFault } from './transform-page-fault'
import { unfinished } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { copySheetValues } = copyMod as typeof import('../../server/src/services/sheet-copy')
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
// 40,000 characters a row: a copy's slice (8,000,000 characters of data) takes 200 rows.
const FILLER = 'f'.repeat(40_000)
const uid = uuid(), tid = uuid(), src = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  .run(src, tid, uid, 'Source', 0, JSON.stringify(['S', 'T', 'F']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) {
    insert.run(uuid(), src, uid, i * 3, JSON.stringify({ S: `s${i}`, T: `t${i}`, F: FILLER }))
  }
}).immediate()

const call = (sheetId: string): Params => ({ sheetId, operation: 'template', template: '{{T}}-x', targetColumn: 'T' })
const cells = (id: string) => db.prepare(`SELECT group_concat(json_extract(data, '$.T')) FROM rows
  WHERE sheet_id = ?`).pluck().get(id)
const ending = (id: string, glob: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.T') GLOB ?`).pluck().get(id, glob) as number
const passIds = (id: string) => db.prepare('SELECT pass_id FROM transform_passes WHERE sheet_id = ?').pluck()
  .all(id) as string[]
async function refused(p: Params, answer: object) {
  const before = cells(p.sheetId)
  assert.deepEqual(await transformColumn(uid, p), answer)
  assert.equal(cells(p.sheetId), before, 'nothing written')
}
async function copied(columns: string[]): Promise<string> {
  const out = await copySheetValues(uid, src, { columns })
  assert.ok('ok' in out && out.ok.rowsCopied === ROWS, JSON.stringify(out).slice(0, 300))
  return out.ok.sheet.id
}

async function main() {
  // Stopped on its second page: 250 rows written, its cursor at the source's row 747 (the 250th).
  fault.arm(251)
  let kept = ''
  try {
    const out = await transformColumn(uid, call(src))
    assert.ok('stopped' in out && out.stopped.rows_done === 250, JSON.stringify(out))
    kept = out.stopped.next_cursor
  } finally { fault.disarm() }

  await check('the copy gets a pass of its own: refused without cursor naming the copy\'s cursor, the original\'s '
    + 'refused there and the copy\'s on the source, and each goes on to end every row once', async () => {
    const copy = await copied(['S', 'T'])
    const [own] = passIds(copy)
    assert.ok(own && passIds(copy).length === 1 && !passIds(src).includes(own), 'a new pass id')
    const answer = await transformColumn(uid, call(copy)) as { unfinished: { next_cursor: string } }
    const mine = answer.unfinished?.next_cursor
    assert.ok(mine && mine !== kept, JSON.stringify(answer))
    assert.match(mine, /^\d+:249:/, 'at the copy\'s 250th row')
    assert.deepEqual(answer, unfinished('T', 250, mine))
    await refused({ ...call(copy), cursor: kept }, unfinished('T', 250, mine))
    await refused({ ...call(src), cursor: mine }, unfinished('T', 250, kept))
    for (const [id, cursor] of [[copy, mine], [src, kept]]) {
      assert.deepEqual(await transformColumn(uid, { ...call(id), cursor }),
        { ok: { updated: ROWS - 250, created_column: null } })
      assert.equal(ending(id, 't*-x'), ROWS)
      assert.equal(ending(id, '*-x-x'), 0)
      assert.deepEqual(passIds(id), [])
    }
  })

  await check('a copy leaving that column out gets no pass', async () => {
    db.prepare('UPDATE rows SET data = json_set(data, \'$.T\', \'t\' || (row_index / 3)) WHERE sheet_id = ?').run(src)
    fault.arm(251)
    try { assert.ok('stopped' in await transformColumn(uid, call(src))) } finally { fault.disarm() }
    const copy = await copied(['S'])
    assert.deepEqual(passIds(copy), [])
    assert.equal(passIds(src).length, 1)
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-pass-copy assertions passed.')
    process.exit(0)
  })

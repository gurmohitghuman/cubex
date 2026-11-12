// A transform_column pass stopped before writing a row (services/column-transform-passes.ts): nothing can get
// its operation twice, so a call without cursor replaces it and runs as a new pass. On 5,000 rows, a where
// matching rows 4,000 and up stops at the time budget after its first page with updated 0 and a cursor; `upper`
// of S into T without where then runs every row, and the old cursor is refused as no longer open. Rows moved
// under such a pass (a sort): its cursor is refused, naming no row done, and the call without cursor runs.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/api-v1-constants'
import sortMod from '../../server/src/services/sheet-sort'
import { moved, notOpen } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { TRANSFORM_MAX_CALL_MS } = constMod as typeof import('../../server/src/lib/api-v1-constants')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
type Params = import('../../server/src/services/column-transform').TransformParams

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
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

const ROWS = 5000
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
let made = 0
function sheet(): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
    .run(id, tid, uid, `S${made}`, made++, JSON.stringify(['S', 'T']))
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) {
      insert.run(uuid(), id, uid, i, JSON.stringify({ S: i >= 4000 ? `late${i}` : `s${i}`, T: `t${i}` }))
    }
  })()
  return id
}
const late = (sheetId: string): Params => ({ sheetId, operation: 'template', template: '{{T}}-x', targetColumn: 'T',
  where: [{ column: 'S', operator: 'starts_with', value: 'late' }] })
const count = (id: string, sql: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND ${sql}`)
  .pluck().get(id) as number
const cells = (id: string) => db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id = ?').pluck().get(id)
// Stopped by its time budget after its first page, which matched no row: its cursor.
async function stoppedEmpty(p: Params): Promise<string> {
  shiftOnRead = true
  const out = await transformColumn(uid, p)
  assert.ok('ok' in out && out.ok.updated === 0 && out.ok.next_cursor, JSON.stringify(out))
  return out.ok.next_cursor
}

async function main() {
  await check('a call without cursor replaces a pass that wrote no row and runs every row; the old cursor is '
    + 'then refused as no longer open', async () => {
    const sid = sheet()
    const cursor = await stoppedEmpty(late(sid))
    assert.deepEqual(await transformColumn(uid, { sheetId: sid, operation: 'upper', sourceColumn: 'S',
      targetColumn: 'T' }), { ok: { updated: ROWS, created_column: null } })
    assert.equal(count(sid, "json_extract(data, '$.T') = upper(json_extract(data, '$.S'))"), ROWS)
    const before = cells(sid)
    assert.deepEqual(await transformColumn(uid, { ...late(sid), cursor }), notOpen)
    assert.equal(cells(sid), before, 'nothing written')
    assert.equal(db.prepare('SELECT count(*) FROM transform_passes WHERE sheet_id = ?').pluck().get(sid), 0)
  })

  await check('rows moved under a pass that wrote no row: its cursor is refused, and the call without cursor '
    + 'runs, every matching row once', async () => {
    const sid = sheet()
    const cursor = await stoppedEmpty(late(sid))
    assert.ok('ok' in await physicalSortSheet(sid, uid, 'S', 'desc'))
    const before = cells(sid)
    assert.deepEqual(await transformColumn(uid, { ...late(sid), cursor }), moved('T', 0))
    assert.equal(cells(sid), before, 'nothing written')
    let written = 0
    for (let next: string | undefined, first = true; first || next; first = false) {
      const out = await transformColumn(uid, { ...late(sid), ...(next ? { cursor: next } : {}) })
      assert.ok('ok' in out, JSON.stringify(out))
      written += out.ok.updated
      next = out.ok.next_cursor
    }
    assert.equal(written, 1000)
    assert.equal(count(sid, "json_extract(data, '$.T') GLOB 't*-x'"), 1000)
    assert.equal(count(sid, "json_extract(data, '$.T') GLOB '*-x-x'"), 0)
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-pass-zero assertions passed.')
    process.exit(0)
  })

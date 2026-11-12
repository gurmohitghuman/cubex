// rows_done counts the pass's own rows (services/column-transform-passes.ts).
// A pass stopped at its call limit keeps its record; the same call sent again
// with restart: true is a new pass, and when its first call writes nothing
// (the rows the first pass changed no longer match), the old record must not
// add the first pass's rows to the new one's count.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/api-v1-constants'
import { transformPageFault } from './transform-page-fault'
import { unfinished } from './transform-pass-words'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { TRANSFORM_MAX_CALL_MS } = constMod as typeof import('../../server/src/lib/api-v1-constants')
type Params = import('../../server/src/services/column-transform').TransformParams

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const realNow = Date.now
let shiftMs = 0
Date.now = () => realNow() + shiftMs
const fault = transformPageFault(db)

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  .run(sid, tid, uid, 'S', 0, JSON.stringify(['N']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => { for (let i = 0; i < 600; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ N: 'n' })) })
  .immediate()
// A row it changed no longer matches its where.
const call: Params = { sheetId: sid, operation: 'template', template: '{{N}}x', targetColumn: 'N',
  where: [{ column: 'N', operator: 'eq', value: 'n' }] }
// A call its time budget stops after its first page, however many turns that page yields: the page's read
// moves the clock past the budget.
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
async function cutShort(restart?: boolean) {
  shiftOnRead = true
  return transformColumn(uid, { ...call, restart })
}

async function main() {
  await check('a new pass whose first call wrote nothing counts only its own rows when it stops on an error',
    async () => {
      const first = await cutShort()
      assert.ok('ok' in first && first.ok.updated === 250 && first.ok.next_cursor, JSON.stringify(first))
      assert.ok('unfinished' in await transformColumn(uid, call), 'the call without cursor is refused')
      const again = await cutShort(true)
      assert.ok('ok' in again && again.ok.updated === 0 && again.ok.next_cursor, JSON.stringify(again))
      fault.arm(251)
      const out = await transformColumn(uid, { ...call, cursor: again.ok.next_cursor })
      fault.disarm()
      assert.ok('stopped' in out, JSON.stringify(out))
      assert.equal(out.stopped.rows_done, 250, out.stopped.error)
      assert.match(out.stopped.error, /^Stopped on an error after 250 rows: /)
      assert.deepEqual(await transformColumn(uid, call), unfinished('N', 250, out.stopped.next_cursor))
    })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-pass-count assertions passed.')
    process.exit(0)
  })

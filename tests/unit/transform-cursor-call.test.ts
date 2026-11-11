// A transform_column cursor belongs to the call that answered it
// (services/column-transform-passes.ts): used on another sheet, or with another
// target column, operation, operation parameter or where, it is refused and
// nothing is written. Into a column with no unfinished pass, the refusal says
// the cursor is another call's; into one with an unfinished pass, it names
// that pass's cursor and restart. The same call with where's keys in another
// order, or with a parameter its operation doesn't use, is the same call: its
// cursor goes on.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import constMod from '../../server/src/lib/api-v1-constants'
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

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 600
const uid = uuid(), tid = uuid(), a = uuid(), b = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const addSheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
for (const [n, id] of [a, b].entries()) {
  addSheet.run(id, tid, uid, `S${n}`, n, JSON.stringify(['N', 'M']))
  db.transaction(() => {
    for (let i = 0; i < ROWS; i++) insert.run(uuid(), id, uid, i, JSON.stringify({ N: `r${i}`, M: `m${i}` }))
  })()
}
const OTHER = 'This cursor belongs to another transform_column call (another sheet or other arguments). Call '
  + 'again without cursor to start over.'
const cells = () => db.prepare('SELECT group_concat(data) FROM rows WHERE sheet_id IN (?, ?) ORDER BY rowid')
  .pluck().get(a, b) as string
// A call its time budget stops after its first page: its next_cursor.
async function cursorOf(p: Params): Promise<string> {
  const call = transformColumn(uid, p)
  setImmediate(() => { shiftMs += TRANSFORM_MAX_CALL_MS })
  const out = await call
  assert.ok('ok' in out && out.ok.next_cursor && out.ok.updated === 250, JSON.stringify(out))
  return out.ok.next_cursor
}

const template: Params = { sheetId: a, operation: 'template', template: '{{N}}x', targetColumn: 'N',
  where: [{ column: 'N', operator: 'not_empty' }] }
const split: Params = { sheetId: a, operation: 'split', sourceColumn: 'N', pattern: 'r', index: 1,
  targetColumn: 'Part' }

async function main() {
  await check('a cursor used on another sheet, or with another target, operation, parameter or where, is '
    + 'refused and writes nothing', async () => {
    const t = await cursorOf(template)
    const s = await cursorOf(split)
    const before = cells()
    const other = { fail: 'invalid', error: OTHER }
    // Into N and Part, each pass stopped after 250 rows is unfinished.
    const intoN = unfinished('N', 250, t), intoPart = unfinished('Part', 250, s)
    const others: Array<[string, Params, object]> = [
      ['another sheet', { ...template, sheetId: b, cursor: t }, other],
      ['another target', { ...template, targetColumn: 'M', cursor: t }, other],
      ['another operation', { ...template, operation: 'upper', sourceColumn: 'N', cursor: t }, intoN],
      ['another template', { ...template, template: '{{N}}y', cursor: t }, intoN],
      ['another where', { ...template, where: [{ column: 'N', operator: 'contains', value: 'r' }], cursor: t }, intoN],
      ['no where', { ...template, where: undefined, cursor: t }, intoN],
      ['the split on another sheet', { ...split, sheetId: b, cursor: s }, other],
      ['another source', { ...split, sourceColumn: 'M', cursor: s }, intoPart],
      ['another pattern', { ...split, pattern: '1', cursor: s }, intoPart],
      ['another index', { ...split, index: 0, cursor: s }, intoPart],
      ['the other call\'s cursor', { ...split, cursor: t }, intoPart],
    ]
    const accepted: string[] = []
    for (const [what, p, refused] of others) {
      const out = await transformColumn(uid, p)
      try { assert.deepEqual(out, refused) } catch { accepted.push(`${what}: ${JSON.stringify(out)}`) }
    }
    assert.deepEqual(accepted, [], 'not refused in its words')
    assert.equal(cells(), before, 'nothing was written')
  })

  await check('the same call, its where\'s keys in another order or with a parameter it doesn\'t use, goes on',
    async () => {
      const t = await cursorOf({ ...template, targetColumn: 'M', template: '{{M}}x' })
      const out = await transformColumn(uid, { ...template, targetColumn: 'M', template: '{{M}}x', pattern: 'unused',
        index: 3, where: [{ operator: 'not_empty', column: 'N' }] as Params['where'], cursor: t })
      assert.ok('ok' in out, JSON.stringify(out))
      const once = db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.M') GLOB 'm*x'
        AND json_extract(data, '$.M') NOT GLOB '*xx'`).pluck().get(a)
      assert.equal(once, ROWS, 'every row once, over both calls')
    })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-cursor-call assertions passed.')
    process.exit(0)
  })

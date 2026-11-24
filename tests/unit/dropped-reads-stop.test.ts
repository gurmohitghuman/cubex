// The whole-sheet reads a box drops when its text changes stop on the server (client/src/lib/typedReads.ts,
// `cancels`): the rule check's scan and the row counts read no more pages once their asker has gone.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { checkRule } = await import('../../server/src/lib/run-condition')
const { scanRule } = await import('../../server/src/services/run-condition-rows')
const { checkRuleOnSheet } = await import('../../server/src/services/run-condition-ai')
const { enrichRowCounts } = await import('../../server/src/services/enrich-row-count')
const { HEAVY_SLICE_ROWS } = await import('../../server/src/lib/constants')

runMigrations()

let failures = 0
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); console.log(`  ok - ${name}`) }
  catch (err) { failures++; console.error(`  FAIL - ${name}:`, err) }
}

const ROWS = 25_000
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Score']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ Score: String(i) }))
}).immediate()

const rule = checkRule('{{Score}} > 100', ['Score'])
const gone = () => true

await check('the rule check reads every row, and only its first page once its asker has gone', async () => {
  const all = await checkRuleOnSheet(uid, sid, '{{Score}} > 100')
  assert.ok('ok' in all && all.ok.rows_checked === ROWS && all.ok.rows_passing === ROWS - 101, JSON.stringify(all))
  const dropped = await checkRuleOnSheet(uid, sid, '{{Score}} > 100', null, gone)
  assert.ok('ok' in dropped && dropped.ok.rows_checked === 10_000, JSON.stringify(dropped))
  const scan = await scanRule({ sheetId: sid, userId: uid, tree: rule.tree, columns: rule.columns, stop: gone })
  assert.equal(scan.considered, 10_000)
})

await check('the row counts count every slice, and only the first once their asker has gone', async () => {
  const scope = { mode: 'all' as const, rowIndexes: null, where: [], rule: rule.tree }
  const all = await enrichRowCounts(sid, uid, null, scope)
  assert.equal(all.total, ROWS - 101)
  const dropped = await enrichRowCounts(sid, uid, null, scope, gone)
  assert.equal(dropped.total, HEAVY_SLICE_ROWS - 101, 'a rule counts a heavy slice at a time')
  const plain = await enrichRowCounts(sid, uid, null, { mode: 'all', rowIndexes: null }, gone)
  assert.ok(plain.total > 0 && plain.total < ROWS, `${plain.total}`)
})

if (failures > 0) process.exitCode = 1
else console.log('dropped-reads-stop: all passed')

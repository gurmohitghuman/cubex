// The writers of column_order that take a list from outside the sheet (column-order-writers.test.ts allows them)
// never drop a name the sheet lists, so they never leave a transform_column pass under a name that's gone:
// set_column_order, REST's PUT /v1/sheets/:id/columns/order and the app's reorder (services/column-reorder.ts)
// refuse a list missing a column, changing nothing; a setup version restored (services/setup-version-*.ts) keeps a
// column the version doesn't have, after the version's column it followed.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const { reorderSheetColumns } = await import('../../server/src/services/column-reorder')
const { addSheetColumn } = await import('../../server/src/services/column-add')
const { saveSetupVersion } = await import('../../server/src/services/setup-version-store')
const { restoreSetupVersion } = await import('../../server/src/services/setup-version-restore')

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(columns: string[]): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S${sid.slice(0, 6)}`, JSON.stringify(columns))
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,0,?)').run(uuid(), sid, uid, '{}')
  return sid
}
const order = (sid: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(sid) as string) as string[]

await check('a new order missing a column is refused and changes nothing; with every column it is taken', () => {
  const sid = sheet(['A', 'B', 'C'])
  assert.deepEqual(reorderSheetColumns(sid, uid, ['B', 'A'], { bumpDataVersion: true }),
    { fail: 'invalid', error: 'Column order must include every column. Missing: C' })
  assert.deepEqual(order(sid), ['A', 'B', 'C'])
  assert.deepEqual(reorderSheetColumns(sid, uid, ['C', 'B', 'A'], { bumpDataVersion: true }), { ok: true })
  assert.deepEqual(order(sid), ['C', 'B', 'A'])
})

await check('a setup version restored keeps a column added since, after the version\'s column it followed',
  async () => {
    const sid = sheet(['A', 'B'])
    const saved = saveSetupVersion(sid, uid, { name: 'A and B' })
    assert.ok('ok' in saved, JSON.stringify(saved))
    assert.ok('ok' in addSheetColumn(sid, uid, 'C'))
    assert.deepEqual(reorderSheetColumns(sid, uid, ['B', 'A', 'C']), { ok: true })
    const out = await restoreSetupVersion(sid, uid, saved.ok.id, { dryRun: false, hasSecretsScope: true,
      reveal: false })
    assert.ok('ok' in out && out.ok.order_changed && !out.ok.nothing, JSON.stringify(out))
    assert.deepEqual(order(sid), ['A', 'C', 'B'])
  })

if (failures) { console.error(`${failures} column-order-lists assertion(s) failed`); process.exit(1) }
console.log('All column-order-lists assertions passed.')
process.exit(0)

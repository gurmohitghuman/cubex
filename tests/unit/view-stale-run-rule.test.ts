// A run-state rule ("has an error") saved on a column that loses its run
// afterwards (its status column deleted, its run gone): the filter panel's
// saves, the row filter's, a view update, and reads and exports through the
// view keep working, the rule reading the column's own cells; a NEW run-state
// rule on a column no run fills is still refused.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import viewsMod from '../../server/src/services/views'
import saveMod from '../../server/src/services/view-filter-save'
import selMod from '../../server/src/services/row-selection'
import exportMod from '../../server/src/lib/csv-export'
import whereMod from '../../server/src/lib/row-filter/where'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { createView, updateView, saveRowFilter } = viewsMod as typeof import('../../server/src/services/views')
const { saveSheetFilters } = saveMod as typeof import('../../server/src/services/view-filter-save')
const { queryRows } = selMod as typeof import('../../server/src/services/row-selection')
const { buildSheetCsv, planSheetExport } = exportMod as typeof import('../../server/src/lib/csv-export')
const { checkWhere } = whereMod as typeof import('../../server/src/lib/row-filter/where')
type WhereItem = import('../../server/src/lib/row-filter/where').WhereItem

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const okOf = (out: object) => { if ('fail' in out) throw new Error(JSON.stringify(out)); return out }
const refused = (out: object, pattern: RegExp) => {
  assert.ok('fail' in out, 'refused')
  const text = String((out as { message?: string; error?: string }).message ?? (out as { error?: string }).error)
  assert.match(text, pattern)
}

await check('checkWhere: a saved run-state rule passes, a new or changed one does not', () => {
  const sheet = { columns: ['Email', 'Company'], runColumns: new Map<string, string>() }
  const rule: WhereItem = { column: 'Email', operator: 'has_error' }
  assert.match(checkWhere([rule], sheet) ?? '', /isn't an AI, HTTP API or enrichment column/)
  assert.equal(checkWhere([rule], { ...sheet, saved: [rule] }), null)
  assert.equal(checkWhere([{ or: [{ ...rule, enabled: false }] }], { ...sheet, saved: [{ and: [rule] }] }), null,
    'on or off, in a group or not')
  assert.match(checkWhere([{ column: 'Email', operator: 'running' }], { ...sheet, saved: [rule] }) ?? '',
    /isn't an AI/, 'another state on that column is new')
  assert.match(checkWhere([{ column: 'Company', operator: 'has_error' }], { ...sheet, saved: [rule] }) ?? '',
    /"Company" isn't an AI/)
  assert.match(checkWhere([{ column: 'Gone', operator: 'has_error' }], { ...sheet, saved: [rule] }) ?? '',
    /Unknown column/, 'a saved rule still needs its column')
})

runMigrations()
const uid = uuid(), tid = uuid(), sid = uuid(), runId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Company', 'Email']))
db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,?,?, 'completed')`)
  .run(runId, sid, uid, 'Email', 'p')
const ROWS = [
  { Company: 'Acme', Email: 'a@acme.example' },
  { Company: 'Bolt', Email: '❌ Model failed' },
  { Company: 'Cog', Email: '' },
]
ROWS.forEach((data, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, i, JSON.stringify(data)))

const STALE: WhereItem = { column: 'Email', operator: 'has_error' }
const companies = (out: object) => (okOf(out) as { ok: { rows: Array<{ data: Record<string, string> }> } })
  .ok.rows.map(r => r.data.Company)

await check('the rule saves while Email is a run column, then its run goes', () => {
  okOf(saveSheetFilters(sid, uid, [STALE]))
  okOf(createView(sid, uid, { name: 'Errors', where: [STALE] }))
  db.prepare('DELETE FROM ai_runs WHERE id = ?').run(runId)
})

await check('the panel saves around the kept rule: other changes, the rule off, the rule on again', () => {
  okOf(saveSheetFilters(sid, uid, [STALE, { column: 'Company', operator: 'not_empty' }]))
  okOf(saveSheetFilters(sid, uid, [{ ...STALE, enabled: false }, { column: 'Company', operator: 'not_empty' }]))
  okOf(saveSheetFilters(sid, uid, [STALE]))
})

await check('a new run-state rule on a column no run fills is still refused', () => {
  refused(saveSheetFilters(sid, uid, [STALE, { column: 'Company', operator: 'has_error' }]), /"Company" isn't an AI/)
  refused(saveSheetFilters(sid, uid, [{ column: 'Email', operator: 'running' }]), /"Email" isn't an AI/)
  okOf(saveSheetFilters(sid, uid, []))
  refused(saveSheetFilters(sid, uid, [STALE]), /"Email" isn't an AI/)
})

await check('the row filter and a view update keep it too', () => {
  db.prepare('UPDATE sheets SET row_filter = ? WHERE id = ?').run(JSON.stringify([{ or: [STALE] }]), sid)
  okOf(saveRowFilter(sid, uid, [{ or: [STALE, { column: 'Company', operator: 'eq', value: 'Cog' }] }]))
  okOf(updateView(sid, uid, 'Errors', { where: [STALE, { column: 'Company', operator: 'not_empty' }] }))
  refused(updateView(sid, uid, 'Errors', { where: [{ column: 'Company', operator: 'has_error' }] }), /isn't an AI/)
})

await check('reads and exports through the view: the rule reads the cell', async () => {
  okOf(updateView(sid, uid, 'Errors', { where: [STALE] }))
  assert.deepEqual(companies(await queryRows(sid, uid, { after: -1, returnMode: 'rows', view: 'Errors' })), ['Bolt'])
  const count = okOf(await queryRows(sid, uid, { after: -1, returnMode: 'count', view: 'Errors',
    where: [{ column: 'Company', operator: 'not_empty' }] })) as { ok: { count: number } }
  assert.equal(count.ok.count, 1)
  const csv = await buildSheetCsv(sid, uid, { view: 'Errors' })
  assert.ok('ok' in csv && csv.rowCount === 1, JSON.stringify(csv))
  // A download link keeps the view's filter as `saved` (mcp/tools-links.ts).
  assert.ok(!('fail' in planSheetExport(sid, uid, { where: [STALE], saved: [STALE] })))
})

await check('a caller\'s own `where` with that rule is checked as new', async () => {
  const out = await queryRows(sid, uid, { after: -1, returnMode: 'rows', where: [STALE] })
  assert.ok('fail' in out && /isn't an AI/.test(out.error))
  const viewed = await queryRows(sid, uid, { after: -1, returnMode: 'rows', view: 'Errors',
    where: [{ column: 'Company', operator: 'has_error' }] })
  assert.ok('fail' in viewed && /"Company" isn't an AI/.test(viewed.error))
  const csv = await buildSheetCsv(sid, uid, { where: [STALE] })
  assert.ok('fail' in csv && csv.fail === 'invalid')
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }

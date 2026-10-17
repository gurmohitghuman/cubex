// Over 200 lines: one sheet fixture walked through every view path (create, switch, hide, ready-made, rename,
// delete, CSV replace, reads and exports), each step building on the last.
// Saved views on a migrated throwaway DB: migration 030 gives every existing
// sheet a Default view holding its filters; a new view copies the active one;
// switching swaps filters between the sheet and the view rows; ready-made
// views; column rename/delete/replace rewrite every view; reads and exports
// through a view; the pure split of a `where` into the grid's three parts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import viewsMod from '../../server/src/services/views'
import storeMod from '../../server/src/services/view-store'
import startersMod from '../../server/src/services/view-starters'
import colsMod from '../../server/src/services/view-columns'
import selMod from '../../server/src/services/row-selection'
import filterMod from '../../server/src/services/row-filter'
import exportMod from '../../server/src/lib/csv-export'
import filtersMod from '../../server/src/lib/views/filters'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { createView, updateView, deleteView, activateView, saveRowFilter } =
  viewsMod as typeof import('../../server/src/services/views')
const { listViews, viewMoved, createDefaultView } = storeMod as typeof import('../../server/src/services/view-store')
const { pickViewStarter } = startersMod as typeof import('../../server/src/services/view-starters')
const { renameViewColumnRefs, deleteViewColumnRefs, pruneViewsToColumns } =
  colsMod as typeof import('../../server/src/services/view-columns')
const { queryRows } = selMod as typeof import('../../server/src/services/row-selection')
const { savedFilterSql } = filterMod as typeof import('../../server/src/services/row-filter')
const { buildSheetCsv } = exportMod as typeof import('../../server/src/lib/csv-export')
const { splitWhere, viewWhere } = filtersMod as typeof import('../../server/src/lib/views/filters')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const ok = <T>(out: { ok: T } | { fail: string; message: string }): T => {
  if ('fail' in out) throw new Error(`${out.fail}: ${out.message}`)
  return out.ok
}

await check('migration 030 gives existing sheets a Default view, active, keeping their filters', () => {
  const dir = path.join(process.cwd(), 'server/src/db/migrations')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  const mem = new Database(':memory:')
  const at = files.indexOf('030_sheet_views.sql')
  for (const f of files.slice(0, at)) mem.exec(fs.readFileSync(path.join(dir, f), 'utf8'))
  mem.prepare("INSERT INTO users (id,password_hash) VALUES ('u','x')").run()
  mem.prepare("INSERT INTO tables (id,user_id,name) VALUES ('t','u','T')").run()
  for (const s of ['s1', 's2']) {
    mem.prepare(`INSERT INTO sheets (id,table_id,user_id,name,position,empty_filter) VALUES (?, 't','u',?,0,?)`)
      .run(s, s, JSON.stringify({ A: 'empty' }))
  }
  mem.exec(fs.readFileSync(path.join(dir, files[at]), 'utf8'))
  const views = mem.prepare('SELECT * FROM sheet_views ORDER BY sheet_id').all() as Array<Record<string, unknown>>
  assert.equal(views.length, 2)
  assert.ok(views.every(v => v.name === 'Default' && v.is_default === 1 && v.empty_filter === null))
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  assert.ok(views.every(v => V4.test(String(v.id))))
  const sheets = mem.prepare('SELECT id, active_view_id, empty_filter FROM sheets ORDER BY id').all() as
    Array<{ active_view_id: string; empty_filter: string }>
  assert.deepEqual(sheets.map(s => s.active_view_id), views.map(v => v.id))
  assert.equal(sheets[0].empty_filter, JSON.stringify({ A: 'empty' }))
})

runMigrations()
const uid = uuid(), tid = uuid(), sid = uuid()
const COLUMNS = ['Company', 'Industry', 'Score', 'Notes']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(COLUMNS))
db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,?,?, 'completed')`)
  .run(uuid(), sid, uid, 'Score', 'p')
const ROWS = [
  { Company: 'Acme', Industry: 'SaaS', Score: '8', Notes: 'x' },
  { Company: 'Bolt', Industry: 'Retail', Score: '❌ Model failed' },
  { Company: 'Cog', Industry: 'SaaS', Score: '' },
  { Company: 'Dyn', Industry: 'Fintech', Score: '3', Notes: 'y' },
]
ROWS.forEach((data, i) => db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, i, JSON.stringify(data)))
const sheetFilters = () => db.prepare('SELECT empty_filter, column_filters, row_filter, active_view_id FROM sheets '
  + 'WHERE id = ?').get(sid) as { empty_filter: string | null; column_filters: string | null; row_filter: string | null;
  active_view_id: string | null }
const viewNamed = (name: string) => listViews(sid, uid)!.find(v => v.name === name)!

await check('a sheet without views gets its Default view when they are listed', () => {
  const views = listViews(sid, uid)!
  assert.equal(views.length, 1)
  assert.equal(views[0].name, 'Default')
  assert.ok(views[0].is_default && views[0].active)
  assert.equal(sheetFilters().active_view_id, views[0].id)
})

await check('a new view copies the active one; switching swaps filters with the sheet', () => {
  db.prepare('UPDATE sheets SET column_filters = ? WHERE id = ?')
    .run(JSON.stringify({ Industry: { type: 'eq', value: 'saas' } }), sid)
  ok(updateView(sid, uid, 'Default', { hidden_columns: ['Notes'] }))
  const copy = ok(createView(sid, uid, { name: 'SaaS only', description: 'Just SaaS', activate: true }))
  assert.ok(copy.active)
  assert.deepEqual(copy.hidden_columns, ['Notes'])
  assert.deepEqual(copy.where, [{ column: 'Industry', operator: 'eq', value: 'saas', values: undefined }])
  // Edit the active view's filters the way the grid does (on the sheet).
  db.prepare('UPDATE sheets SET column_filters = ? WHERE id = ?')
    .run(JSON.stringify({ Industry: { type: 'eq', value: 'fintech' } }), sid)
  ok(activateView(sid, uid, 'default'))
  assert.equal(sheetFilters().column_filters, JSON.stringify({ Industry: { type: 'eq', value: 'saas' } }))
  assert.equal(viewNamed('SaaS only').where[0]?.column, 'Industry')
  assert.equal((viewNamed('SaaS only').where[0] as { value: string }).value, 'fintech')
  ok(activateView(sid, uid, viewNamed('SaaS only').id))
  assert.equal(sheetFilters().column_filters, JSON.stringify({ Industry: { type: 'eq', value: 'fintech' } }))
  const raw = db.prepare('SELECT column_filters FROM sheet_views WHERE name = ?').get('SaaS only') as
    { column_filters: string | null }
  assert.equal(raw.column_filters, null, 'the active view keeps its filters on the sheet only')
})

await check('names are unique in any case; hidden columns are checked', () => {
  const dup = createView(sid, uid, { name: 'saas ONLY' })
  assert.ok('fail' in dup && dup.fail === 'conflict')
  ok(createView(sid, uid, { name: 'Ünique' }))
  const accented = createView(sid, uid, { name: 'ünique' })
  assert.ok('fail' in accented && accented.fail === 'conflict', 'case folds beyond ASCII')
  ok(deleteView(sid, uid, 'Ünique'))
  const badFrom = createView(sid, uid, { name: 'X', from: 5 })
  assert.ok('fail' in badFrom && badFrom.fail === 'bad_request')
  const unknown = updateView(sid, uid, 'Default', { hidden_columns: ['Nope'] })
  assert.ok('fail' in unknown && unknown.fail === 'bad_request')
  const all = updateView(sid, uid, 'Default', { hidden_columns: COLUMNS })
  assert.ok('fail' in all && /at least one column/.test(all.message))
  const blank = createView(sid, uid, { name: '  ' })
  assert.ok('fail' in blank && blank.fail === 'bad_request')
})

await check('a filter change made in another view is refused', () => {
  const active = sheetFilters().active_view_id!
  assert.equal(viewMoved(sid, uid, active), false)
  assert.equal(viewMoved(sid, uid, viewNamed('Default').id), true)
  assert.equal(viewMoved(sid, uid, undefined), false)
})

await check('"Rows with errors": any run column, read by the grid and the API', async () => {
  const view = ok(pickViewStarter(sid, uid, 'errors'))
  assert.ok(view.active)
  assert.deepEqual(view.where, [{ operator: 'has_error' }])
  assert.equal(sheetFilters().row_filter, JSON.stringify([{ operator: 'has_error' }]))
  const sql = savedFilterSql(sid, uid, sheetFilters())!
  const n = db.prepare(`SELECT COUNT(*) AS n FROM rows WHERE sheet_id = ? AND (${sql.sql})`).get(sid, ...sql.params) as
    { n: number }
  assert.equal(n.n, 1)
  const again = ok(pickViewStarter(sid, uid, 'errors'))
  assert.equal(again.id, view.id, 'picking it again switches to it')
  const rows = ok(await queryRows(sid, uid, { after: -1, returnMode: 'rows', view: 'Rows with errors' }) as never) as
    { rows: Array<{ data: Record<string, string> }> }
  assert.deepEqual(rows.rows.map(r => r.data.Company), ['Bolt'])
  ok(saveRowFilter(sid, uid, null))
  assert.equal(sheetFilters().row_filter, null)
  ok(saveRowFilter(sid, uid, [{ operator: 'has_error' }]))
})

await check('"Fully filled rows": a has_result per run column, shown on its header', () => {
  const view = ok(pickViewStarter(sid, uid, 'filled'))
  assert.equal(sheetFilters().column_filters, JSON.stringify({ Score: { type: 'has_result' } }))
  assert.equal(view.where.length, 1)
  const none = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,1,?)')
  const bare = uuid()
  none.run(bare, tid, uid, 'Bare', JSON.stringify(['A']))
  const refused = pickViewStarter(bare, uid, 'errors')
  assert.ok('fail' in refused && /no AI, HTTP API or enrichment/.test(refused.message))
})

await check('reads and exports through a view: its rows and its visible columns', async () => {
  ok(updateView(sid, uid, 'SaaS only', { where: [{ column: 'Industry', operator: 'eq', value: 'SaaS' }] }))
  const page = ok(await queryRows(sid, uid, { after: -1, returnMode: 'rows', view: 'saas only' }) as never) as
    { rows: Array<{ data: Record<string, string> }> }
  assert.deepEqual(page.rows.map(r => Object.keys(r.data)), [['Company', 'Industry', 'Score'],
    ['Company', 'Industry', 'Score']])
  const count = ok(await queryRows(sid, uid, { after: -1, returnMode: 'count', view: 'SaaS only',
    where: [{ column: 'Score', operator: 'not_empty' }] }) as never) as { count: number }
  assert.equal(count.count, 1)
  const csv = await buildSheetCsv(sid, uid, { view: 'SaaS only' })
  assert.ok('ok' in csv)
  assert.equal(csv.csv, '"Company","Industry","Score"\r\n"Acme","SaaS","8"\r\n"Cog","SaaS",""')
  const first = ok(await queryRows(sid, uid, { after: -1, limit: 1, returnMode: 'rows', view: 'SaaS only' }) as never) as
    { rows: Array<{ index: number }>; view_version: string; data_version: number; row_generation: number }
  assert.match(first.view_version, /^[0-9a-f]{16}$/)
  const next = { after: first.rows[0].index, returnMode: 'rows' as const, view: 'SaaS only',
    expectedDataVersion: first.data_version, expectedRowGeneration: first.row_generation }
  const unfenced = await queryRows(sid, uid, next)
  assert.ok('fail' in unfenced && /expected_view_version/.test(unfenced.error))
  assert.ok('ok' in await queryRows(sid, uid, { ...next, expectedViewVersion: first.view_version }))
  ok(updateView(sid, uid, 'SaaS only', { where: [{ column: 'Industry', operator: 'eq', value: 'Retail' }] }))
  const moved = await queryRows(sid, uid, { ...next, expectedViewVersion: first.view_version })
  assert.ok('fail' in moved && moved.fail === 'version_conflict')
  ok(updateView(sid, uid, 'SaaS only', { where: [{ column: 'Industry', operator: 'eq', value: 'SaaS' }] }))
  const missing = await buildSheetCsv(sid, uid, { view: 'Nope' })
  assert.ok('fail' in missing && missing.fail === 'invalid' && /No view "Nope"/.test(missing.error))
  const active = await buildSheetCsv(sid, uid, { view: 'active' })
  assert.ok('ok' in active && active.rowCount === 2, 'the active view is "Fully filled rows"')
})

await check('rename and delete of a column rewrite every view and the sheet', () => {
  ok(updateView(sid, uid, 'SaaS only', { where: [
    { column: 'Industry', operator: 'eq', value: 'SaaS' },
    { or: [{ column: 'Industry', operator: 'empty' }, { column: 'Notes', operator: 'empty' }] },
  ], hidden_columns: ['Notes'] }))
  db.prepare('UPDATE sheets SET row_filter = ? WHERE id = ?')
    .run(JSON.stringify([{ or: [{ column: 'Industry', operator: 'eq', value: 'a' }] }]), sid)
  db.transaction(() => renameViewColumnRefs(sid, uid, 'Industry', 'Sector'))()
  const saas = viewNamed('SaaS only')
  assert.equal(JSON.stringify(saas.where).includes('Industry'), false)
  assert.equal(JSON.stringify(saas.where).match(/Sector/g)?.length, 2)
  assert.match(sheetFilters().row_filter!, /Sector/)
  db.transaction(() => deleteViewColumnRefs(sid, uid, 'Notes'))()
  const after = viewNamed('SaaS only')
  assert.deepEqual(after.hidden_columns, [])
  const raw = db.prepare('SELECT hidden_columns, row_filter FROM sheet_views WHERE name = ?').get('SaaS only') as
    { hidden_columns: string | null; row_filter: string | null }
  assert.equal(raw.hidden_columns, null)
  assert.equal(raw.row_filter, null, 'an OR group losing a condition goes whole (keeping the rest would narrow it)')
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Company']), sid)
  db.transaction(() => pruneViewsToColumns(sid, uid))()
  assert.deepEqual(viewNamed('SaaS only').where, [])
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(COLUMNS), sid)
})

await check('the Default view stays; deleting the active view switches to Default', () => {
  const refused = deleteView(sid, uid, 'Default')
  assert.ok('fail' in refused && /can't be deleted/.test(refused.message))
  ok(activateView(sid, uid, 'SaaS only'))
  ok(updateView(sid, uid, 'SaaS only', { where: [{ column: 'Company', operator: 'contains', value: 'a' }] }))
  const defaultFilters = db.prepare('SELECT column_filters FROM sheet_views WHERE is_default = 1 AND sheet_id = ?')
    .get(sid) as { column_filters: string | null }
  ok(deleteView(sid, uid, 'SaaS only'))
  const state = sheetFilters()
  assert.equal(state.active_view_id, viewNamed('Default').id)
  assert.equal(state.column_filters, defaultFilters.column_filters)
  assert.equal(listViews(sid, uid)!.some(v => v.name === 'SaaS only'), false)
})

await check('a new sheet gets a Default view; deleting the sheet deletes its views', () => {
  const s2 = uuid()
  db.transaction(() => {
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position) VALUES (?,?,?,?,2)').run(s2, tid, uid, 'New')
    createDefaultView(s2, uid)
  })()
  assert.equal(listViews(s2, uid)!.length, 1)
  db.prepare('DELETE FROM sheets WHERE id = ?').run(s2)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sheet_views WHERE sheet_id = ?').get(s2) as { n: number }).n, 0)
})

await check('splitWhere puts each column\'s first condition on its header, the rest in row_filter', () => {
  const where = [
    { column: 'A', operator: 'empty' as const },
    { column: 'A', operator: 'contains' as const, value: 'x' },
    { column: 'A', operator: 'eq' as const, value: 'y' },
    { operator: 'has_error' as const },
    { or: [{ column: 'B', operator: 'empty' as const }] },
  ]
  const split = splitWhere(where)
  assert.equal(split.empty_filter, JSON.stringify({ A: 'empty' }))
  assert.equal(split.column_filters, JSON.stringify({ A: { type: 'contains', value: 'x' } }))
  assert.equal(JSON.parse(split.row_filter!).length, 3)
  assert.equal(viewWhere(split).length, 5)
  assert.deepEqual(splitWhere([]), { empty_filter: null, column_filters: null, row_filter: null })
})

if (failures) { console.error(`${failures} view check(s) failed`); process.exit(1) }
console.log('views: all checks passed')

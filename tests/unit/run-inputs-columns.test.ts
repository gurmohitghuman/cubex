// What a run reads (lib/run-inputs/columns.ts) as its run resolves it, and
// through renames: an enrichment input renamed to a name holding "}" (written
// as the normalized {{token}}) still reads its column, and a column read
// through two token forms is one input before and after a rename, so neither
// rename marks a row out of date. Pure checks first, then the same on a
// migrated throwaway DB through the real rename.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

runMigrations()
const { aiRunInputColumns, requestRunInputColumns } = await import('../../server/src/lib/run-inputs/columns')
const { requestRunStamper } = await import('../../server/src/lib/run-inputs/stampers')
const { writeRunCells } = await import('../../server/src/lib/run-cells-write')
const { resolveRerunTargets } = await import('../../server/src/services/ai-rerun-modes')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')

const enrichment = (body: Record<string, string>, gone?: string[]) => ({
  enrichment: { v: 1 }, responseMapping: [],
  requestConfig: { method: 'POST', url: 'https://treg.test/x', headers: {}, body: JSON.stringify(body),
    ...(gone ? { goneColumns: gone } : {}) },
}) as never
const request = (url: string, body = '', gone?: string[]) => ({
  responseMapping: [{ jsonPath: '$.a', columnName: 'Out' }],
  requestConfig: { method: 'POST', url, headers: {}, body, ...(gone ? { goneColumns: gone } : {}) },
}) as never
const ai = (prompt: string) => ({ column_name: 'X (Output)', prompt, output_columns: null,
  use_openrouter_web_search: 0 }) as never

await check('an enrichment input resolves as its run does: exact, any case, or the normalized name', () => {
  const cols = ['Name', 'Site {x}', 'Status']
  assert.deepEqual(requestRunInputColumns(enrichment({ domain: '{{site_x}}' }), 'Status', cols), ['Site {x}'])
  assert.deepEqual(requestRunInputColumns(enrichment({ name: '{{name}}', fixed: 'acme' }), 'Status', cols),
    ['Name'])
  // A column that isn't there keeps its place, read as empty.
  assert.deepEqual(requestRunInputColumns(enrichment({ domain: '{{Website}}' }), 'Status', cols), [null])
})

await check('an enrichment reads a column by a deleted name again once it is back (its run does)', () => {
  const cfg = enrichment({ domain: '{{Website}}' }, ['Website'])
  assert.deepEqual(requestRunInputColumns(cfg, 'Status', ['Website', 'Status']), ['Website'])
})

await check('two token forms of one column are one input (HTTP and AI)', () => {
  const cols = ['Company Name', 'Out', 'Call']
  assert.deepEqual(requestRunInputColumns(request('https://a.test/?q={{Company Name}}', '{"c":"/company_name"}'),
    'Call', cols), ['Company Name'])
  assert.deepEqual(aiRunInputColumns(ai('About /a-b, also /a_b and /A-B'), ['A-B']), ['A-B'])
})

await check('tokens naming no column stay apart by their own text', () => {
  const cfg = request('https://a.test/?q={{Gone One}}&r={{Gone Two}}&s={{gone one}}', '', ['Gone One', 'Gone Two'])
  assert.deepEqual(requestRunInputColumns(cfg, 'Call', ['Call', 'Out']), [null, null])
  assert.deepEqual(aiRunInputColumns(ai('/missing and /other and /MISSING'), ['Name']), [null, null])
})

// The same through the real rename on a sheet whose rows were stamped by the run.
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const RUN = { kind: 'http' as const, id: uuid() }
const insertRow = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')

// A sheet whose run (config) has stamped every row; returns the sheet id.
function stampedSheet(name: string, columns: string[], rows: Array<Record<string, string>>, master: string,
  config: object): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, name, JSON.stringify(columns))
  rows.forEach((d, i) => insertRow.run(uuid(), sid, uid, i, JSON.stringify(d)))
  db.prepare('INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name) VALUES (?,?,?,?,?,?)')
    .run(uuid(), sid, uid, JSON.stringify(config), 'completed', master)
  const s = requestRunStamper({ sheet_id: sid, user_id: uid, master_column_name: master }, config as never)!
  rows.forEach((_d, i) => {
    const raw = db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = ?').pluck().get(sid, i) as string
    writeRunCells(RUN, sid, uid, i, [[master, '✅']], s.stamp(raw))
  })
  return sid
}
const setCell = (sid: string, i: number, column: string, value: string) => db.prepare(
  `UPDATE rows SET data = json_set(data, '$."' || ? || '"', ?) WHERE sheet_id = ? AND row_index = ?`,
).run(column, value, sid, i)

await check('an enrichment input renamed to "Site {x}": no row out of date, an edit still marks its row', async () => {
  const sid = stampedSheet('Enrich', ['Website', 'Status'], [{ Website: 'a.com' }, { Website: 'b.com' }], 'Status',
    enrichment({ domain: '{{Website}}' }))
  assert.deepEqual(await resolveRerunTargets(sid, uid, 'Status', 'out_of_date'), [])
  const r = await renameSheetColumn(sid, uid, 'Website', 'Site {x}')
  assert.ok('ok' in r, JSON.stringify(r))
  const body = db.prepare('SELECT config FROM http_runs WHERE sheet_id = ?').pluck().get(sid) as string
  assert.ok(body.includes('{{site_x}}'), body)
  assert.deepEqual(await resolveRerunTargets(sid, uid, 'Status', 'out_of_date'), [])
  setCell(sid, 1, 'Site {x}', 'c.com')
  assert.deepEqual(await resolveRerunTargets(sid, uid, 'Status', 'out_of_date'), [1])
})

await check('{{Company}} + /company renamed to "Company Name": still one input, no row out of date', async () => {
  const sid = stampedSheet('Mixed', ['Company', 'Call'], [{ Company: 'Acme' }, { Company: 'Beta' }], 'Call',
    { responseMapping: [], requestConfig: { method: 'POST', url: 'https://a.test/?q={{Company}}', headers: {},
      body: '{"c":"/company"}' } })
  const r = await renameSheetColumn(sid, uid, 'Company', 'Company Name')
  assert.ok('ok' in r, JSON.stringify(r))
  assert.deepEqual(await resolveRerunTargets(sid, uid, 'Call', 'out_of_date'), [])
  setCell(sid, 0, 'Company Name', 'Acme Inc')
  assert.deepEqual(await resolveRerunTargets(sid, uid, 'Call', 'out_of_date'), [0])
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('all run-inputs columns checks passed')

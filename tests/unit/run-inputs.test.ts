// Over 200 lines: one scenario on one sheet, each check building on the rows the last left.
// Out-of-date results (lib/run-inputs, migration 039) on a migrated throwaway
// DB: a run's stamp of the inputs it read, written with its result, against
// the row's cells now. Covers the fingerprint (markers read empty, values are
// length-prefixed), stale rows found the same way by filters, include_status,
// rerun targets, enrichment statuses and the menu counts, and the column key
// through renames of an input and of the run's own column.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import fpMod from '../../server/src/lib/run-inputs/fingerprint'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { runInputFingerprint } = fpMod as typeof import('../../server/src/lib/run-inputs/fingerprint')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

runMigrations()
const { aiRunStamper, requestRunStamper } = await import('../../server/src/lib/run-inputs/stampers')
const { writeRunCells } = await import('../../server/src/lib/run-cells-write')
const { columnStaleCheck } = await import('../../server/src/services/run-inputs')
const { resolveRerunTargets } = await import('../../server/src/services/ai-rerun-modes')
const { prepareWhere, sheetRunColumns } = await import('../../server/src/services/row-filter')
const { staleByRow } = await import('../../server/src/services/run-status-rows')
const { rowWithStatus } = await import('../../server/src/lib/row-filter/status-rows')
const { runColumnCounts } = await import('../../server/src/services/run-controls-counts')
const { enrichRowCounts, countFor } = await import('../../server/src/services/enrich-row-count')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
const { deleteSheetColumn } = await import('../../server/src/services/column-delete')
const { matchPromptColumn } = await import('../../server/src/lib/prompt')
const { deleteRunInputKey } = await import('../../server/src/lib/run-inputs/keys')
const { purgeColumnKey, recordPurge } = await import('../../server/src/lib/column-purge')

const uid = uuid(), tid = uuid(), sid = uuid()
// The run whose undo journal the writes go into (not read here).
const RUN = { kind: 'ai' as const, id: uuid() }
const OUT = 'Summary (Output)'
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Name', 'City', OUT, 'Lookup']))
const people = [['Ada', 'Paris'], ['Bo', 'Rome'], ['Cy', ''], ['Di', 'Oslo'], ['Ed', 'Lima']]
const insertRow = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
people.forEach(([Name, City], i) => insertRow.run(uuid(), sid, uid, i, JSON.stringify({ Name, City })))
const ai = { sheet_id: sid, user_id: uid, column_name: OUT, prompt: 'Describe /name from /city', output_columns: null,
  use_openrouter_web_search: 0 }
db.prepare('INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status) VALUES (?,?,?,?,?,?)')
  .run(uuid(), sid, uid, OUT, ai.prompt, 'completed')

const raw = (i: number) => db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = ?').pluck()
  .get(sid, i) as string
const setCell = (i: number, column: string, value: string) => db.prepare(
  `UPDATE rows SET data = json_set(data, '$."' || ? || '"', ?) WHERE sheet_id = ? AND row_index = ?`,
).run(column, value, sid, i)
// The run: rows 0-3 get a result (row 3 fails), row 4 is never run.
const stamper = aiRunStamper(ai)
for (const i of [0, 1, 2, 3]) {
  writeRunCells(RUN, sid, uid, i, [[OUT, i === 3 ? '❌ Error: boom' : `About ${people[i][0]}`]], stamper.stamp(raw(i)))
}
const staleRows = () => {
  const c = columnStaleCheck(sid, uid, OUT)
  if (!c) return []
  return db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND ${c.sql} ORDER BY row_index`).pluck()
    .all(sid, ...c.params) as number[]
}
const whereRows = (where: unknown[]) => {
  const p = prepareWhere(sid, uid, where as never)
  if ('error' in p) throw new Error(p.error)
  return db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND (${p.ok.filter.sql}) ORDER BY row_index`)
    .pluck().all(sid, ...p.ok.filter.params) as number[]
}

await check('fingerprint: markers read as empty, values are length-prefixed, the count leads', () => {
  assert.equal(runInputFingerprint(['⏳ Processing...']), runInputFingerprint(['']))
  assert.equal(runInputFingerprint([null]), runInputFingerprint(['']))
  assert.notEqual(runInputFingerprint(['ab', 'c']), runInputFingerprint(['a', 'bc']))
  assert.notEqual(runInputFingerprint(['x']), runInputFingerprint(['x', '']))
  assert.equal(runInputFingerprint([5]), runInputFingerprint(['5']))
})

await check('nothing is out of date right after the run', () => assert.deepEqual(staleRows(), []))

await check('an edited input makes its row out of date; editing it back does not', () => {
  setCell(0, 'City', 'Lyon')
  assert.deepEqual(staleRows(), [0])
  setCell(0, 'City', 'Paris')
  assert.deepEqual(staleRows(), [])
  setCell(0, 'City', 'Lyon')
  // A column the prompt doesn't read changes nothing.
  setCell(1, 'Lookup', 'anything')
  assert.deepEqual(staleRows(), [0])
})

await check('a marker written into an input reads as the empty value it had', () => {
  setCell(2, 'City', '⏳ Processing...')
  assert.deepEqual(staleRows(), [0])
  setCell(2, 'City', 'Rome')
  assert.deepEqual(staleRows(), [0, 2])
})

await check('a failed row whose input changed is failed, not out of date', async () => {
  setCell(3, 'City', 'Bergen')
  assert.deepEqual(staleRows(), [0, 2, 3])
  assert.deepEqual(await resolveRerunTargets(sid, uid, OUT, 'out_of_date'), [0, 2])
  assert.deepEqual(await resolveRerunTargets(sid, uid, OUT, 'empty_or_out_of_date'), [0, 2, 4])
  assert.deepEqual(await resolveRerunTargets(sid, uid, OUT, 'errored'), [3])
})

await check('where out_of_date (one column, any column) and include_status agree', () => {
  assert.deepEqual(whereRows([{ column: OUT, operator: 'out_of_date' }]), [0, 2])
  assert.deepEqual(whereRows([{ operator: 'out_of_date' }]), [0, 2])
  assert.deepEqual(whereRows([{ column: OUT, operator: 'has_result' }]), [0, 1, 2])
  const runs = sheetRunColumns(sid, uid, ['Name', 'City', OUT, 'Lookup'])
  const rows = db.prepare('SELECT id, row_index, data FROM rows WHERE sheet_id = ? ORDER BY row_index')
    .all(sid) as Array<{ id: string; row_index: number; data: string }>
  const stale = staleByRow(sid, uid, rows.map(r => r.id), runs)
  const status = rows.map(r => (rowWithStatus(JSON.parse(r.data), runs, [OUT], stale.get(r.id))[OUT] as
    { status: string; value: string | null }))
  assert.deepEqual(status.map(s => s.status), ['out_of_date', 'done', 'out_of_date', 'error', 'not_run'])
  assert.equal(status[0].value, 'About Ada')
})

await check('menu counts: rows, empty, out of date, failed', async () => {
  const c = await runColumnCounts(sid, uid, OUT)
  assert.ok('ok' in c)
  assert.deepEqual(c.ok, { total: 5, empty: 1, outOfDate: 2, failed: 1 })
})

await check('renaming an input keeps every row as it was; renaming the run column keeps its key', async () => {
  const r1 = await renameSheetColumn(sid, uid, 'City', 'Town')
  assert.ok('ok' in r1, JSON.stringify(r1))
  assert.deepEqual(staleRows(), [0, 2, 3])
  const r2 = await renameSheetColumn(sid, uid, OUT, 'Blurb (Output)')
  assert.ok('ok' in r2, JSON.stringify(r2))
  const c = columnStaleCheck(sid, uid, 'Blurb (Output)')
  assert.ok(c)
  assert.equal(columnStaleCheck(sid, uid, OUT), null)
  assert.deepEqual(await resolveRerunTargets(sid, uid, 'Blurb (Output)', 'out_of_date'), [0, 2])
})

await check('an HTTP API column stamps its {{inputs}}; enrichment statuses count and match out of date', async () => {
  const config = { requestConfig: { method: 'GET', url: 'https://api.test/?q={{Name}}', headers: {} },
    responseMapping: [] }
  db.prepare('INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name) VALUES (?,?,?,?,?,?)')
    .run(uuid(), sid, uid, JSON.stringify(config), 'completed', 'Lookup')
  const s = requestRunStamper({ sheet_id: sid, user_id: uid, master_column_name: 'Lookup' }, config as never)!
  for (const i of [0, 1, 2, 3, 4]) {
    writeRunCells(RUN, sid, uid, i, [['Lookup', i === 4 ? '⏭️ Not found' : '✅']], s.stamp(raw(i)))
  }
  setCell(4, 'Name', 'Eddie')
  setCell(1, 'Town', 'Turin')
  const counts = await enrichRowCounts(sid, uid, 'Lookup',
    { mode: 'all', rowIndexes: null, stale: columnStaleCheck(sid, uid, 'Lookup') })
  assert.equal(counts.outOfDate, 1, JSON.stringify(counts))
  assert.equal(countFor(counts, 'empty_or_out_of_date'), 1)
  assert.deepEqual(await resolveRerunTargets(sid, uid, 'Lookup', 'out_of_date'), [4])
})

await check('a deleted run column\'s key leaves every row with the column\'s purge', async () => {
  const key = (db.prepare('SELECT id FROM run_input_keys WHERE sheet_id = ? AND column_name = ?').pluck()
    .get(sid, 'Lookup')) as number
  const holding = () => (db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ?
    AND json_type(run_inputs, '$."' || ? || '"') IS NOT NULL`).pluck().get(sid, String(key))) as number
  assert.equal(holding(), 5)
  db.transaction(() => { deleteRunInputKey(sid, uid, 'Lookup'); recordPurge(sid, uid, 'Lookup') })()
  assert.equal(columnStaleCheck(sid, uid, 'Lookup'), null)
  await purgeColumnKey(sid, uid, 'Lookup')
  assert.equal(holding(), 0)
  // The other column's fingerprints stay.
  assert.deepEqual(await resolveRerunTargets(sid, uid, 'Blurb (Output)', 'out_of_date'), [0, 1, 2])
  assert.equal(db.prepare('SELECT COUNT(*) FROM run_input_purges WHERE sheet_id = ?').pluck().get(sid), 0)
})

await check('a deleted input makes out of date only the rows whose cell in it held something', async () => {
  // A second sheet: an HTTP API column reading {{Name}} and {{Extra}}, Extra blank on row 1.
  const s2 = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,1,?)')
    .run(s2, tid, uid, 'Two', JSON.stringify(['Name', 'Extra', 'Call']))
  const rows = [{ Name: 'Ada', Extra: 'x' }, { Name: 'Bo', Extra: '' }, { Name: 'Cy', Extra: 'y' }]
  rows.forEach((d, i) => insertRow.run(uuid(), s2, uid, i, JSON.stringify(d)))
  const config = { requestConfig: { method: 'GET', url: 'https://api.test/?q={{Name}}&e={{Extra}}', headers: {} },
    responseMapping: [] }
  db.prepare('INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name) VALUES (?,?,?,?,?,?)')
    .run(uuid(), s2, uid, JSON.stringify(config), 'completed', 'Call')
  const s = requestRunStamper({ sheet_id: s2, user_id: uid, master_column_name: 'Call' }, config as never)!
  const raw2 = (i: number) => db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = ?').pluck()
    .get(s2, i) as string
  for (const i of [0, 1, 2]) writeRunCells(RUN, s2, uid, i, [['Call', '✅ Success']], s.stamp(raw2(i)))
  assert.deepEqual(await resolveRerunTargets(s2, uid, 'Call', 'out_of_date'), [])
  const out = await deleteSheetColumn(s2, uid, 'Extra')
  assert.ok('ok' in out || 'success' in (out as object), JSON.stringify(out))
  assert.deepEqual(await resolveRerunTargets(s2, uid, 'Call', 'out_of_date'), [0, 2])
})

await check('a /token naming two columns: the one matching it ignoring case wins, everywhere', () => {
  assert.equal(matchPromptColumn('company_name', ['Company Name', 'company_name']), 'company_name')
  assert.equal(matchPromptColumn('company_name', ['company_name', 'Company Name']), 'company_name')
  assert.equal(matchPromptColumn('company_name', ['Company Name']), 'Company Name')
  assert.equal(matchPromptColumn('nope', ['Company Name']), undefined)
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('all run-inputs checks passed')

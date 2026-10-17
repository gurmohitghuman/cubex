// Over 200 lines: one sheet fixture shared by every reader the filter engine serves (read, export, transfer, grid).
// Row filters through the services, on a migrated throwaway DB: the run
// columns a sheet's run records name (an AI column with its "(Data)" column,
// an enrichment with two outputs) and the column holding each one's state;
// read_rows / REST rows/query with run-state operators, OR groups, counts,
// filtered paging and include_status; the grid's saved filters (saved,
// refused, compiled); CSV export and transfer scans with a `where`.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import selMod from '../../server/src/services/row-selection'
import filterMod from '../../server/src/services/row-filter'
import readMod from '../../server/src/services/workspace-read'
import exportMod from '../../server/src/lib/csv-export'
import transferMod from '../../server/src/services/transfer-selection'
import scanMod from '../../server/src/lib/filtered-scan'
import busyModule from '../../server/src/lib/sheet-busy'
import type { WhereItem } from '../../server/src/lib/row-filter/where'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { queryRows, parseRowQueryBody } = selMod as typeof import('../../server/src/services/row-selection')
const { sheetRunColumns, saveColumnFilters, savedFilterSql, prepareWhere } =
  filterMod as typeof import('../../server/src/services/row-filter')
const { readRowsPage } = readMod as typeof import('../../server/src/services/workspace-read')
const { buildSheetCsv } = exportMod as typeof import('../../server/src/lib/csv-export')
const { scanTransferRows } = transferMod as typeof import('../../server/src/services/transfer-selection')
const { scanFiltered } = scanMod as typeof import('../../server/src/lib/filtered-scan')
const busyMod = busyModule as typeof import('../../server/src/lib/sheet-busy')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
const COLUMNS = ['Company', 'Fit (Output)', 'Fit (Data)', 'Status', 'Email', 'Phone']
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(COLUMNS))
// A web-search AI run (its "(Data)" column) and an enrichment with two outputs.
// Auto-run makes many runs per column: two of each, naming the same columns.
for (let i = 0; i < 2; i++) {
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,use_openrouter_web_search)
    VALUES (?,?,?,?,?, 'completed', 1)`).run(uuid(), sid, uid, 'Fit (Output)', 'p')
  const run = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?, 'completed', 'Status')`).run(run, sid, uid, JSON.stringify({ enrichment: { v: 1 } }))
  for (const out of ['Email', 'Phone']) {
    db.prepare(`INSERT INTO http_column_associations
      (id,sheet_id,user_id,master_column_name,extracted_column_name,run_id) VALUES (?,?,?,?,?,?)`)
      .run(uuid(), sid, uid, 'Status', out, run)
  }
}
const ROWS: Array<Record<string, string>> = [
  { Company: 'Acme', 'Fit (Output)': 'yes', 'Fit (Data)': '📊 3 sources', Status: '✅ Found',
    Email: 'a@acme.com', Phone: '' },
  { Company: 'Beta', 'Fit (Output)': '❌ Error: Rate limited', 'Fit (Data)': '❌ Error', Status: '❌ Timed out',
    Email: '', Phone: '' },
  { Company: 'Gamma', 'Fit (Output)': '⏭️ Condition not met', 'Fit (Data)': '', Status: '⏭️ Condition not met',
    Email: '', Phone: '' },
  { Company: 'Delta', 'Fit (Output)': '', Status: '' },
  { Company: 'Epsilon', 'Fit (Output)': '⏳ Processing...', Status: '➕ Adding 3 rows…' },
  { Company: 'Zeta', 'Fit (Output)': 'no', Status: '⏭️ Not found', Email: '', Phone: '' },
  { Company: 'MÜNCHEN GmbH' },
]
const ids = ROWS.map((data, i) => {
  const id = uuid()
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(id, sid, uid, i, JSON.stringify(data))
  return id
})

const query = async (body: Record<string, unknown>) => {
  const parsed = parseRowQueryBody(body, 500)
  if ('error' in parsed) return { fail: 'invalid', error: parsed.error } as const
  return queryRows(sid, uid, parsed.query)
}
const companies = async (body: Record<string, unknown>) => {
  const r = await query({ ...body, columns: ['Company'] })
  assert.ok('ok' in r, JSON.stringify(r))
  return (r.ok.rows as Array<{ data: { Company: string } }>).map(x => x.data.Company)
}
const count = async (where: WhereItem[]) => {
  const r = await query({ where, return_mode: 'count' })
  assert.ok('ok' in r, JSON.stringify(r))
  return r.ok.count
}

await check('run columns and their state columns come from the run records', () => {
  assert.deepEqual(Object.fromEntries(sheetRunColumns(sid, uid, COLUMNS)), {
    'Fit (Output)': 'Fit (Output)', 'Fit (Data)': 'Fit (Output)', Status: 'Status', Email: 'Status', Phone: 'Status',
  })
  // A status column the sheet no longer has: its outputs read their own cells.
  assert.equal(sheetRunColumns(sid, uid, ['Email']).get('Email'), 'Email')
})
await check('run-state operators on a column and on any run column', async () => {
  assert.deepEqual(await companies({ where: [{ operator: 'has_error' }] }), ['Beta'])
  assert.deepEqual(await companies({ where: [{ column: 'Email', operator: 'has_error' }] }), ['Beta'])
  assert.deepEqual(await companies({ where: [{ column: 'Email', operator: 'has_result' }] }), ['Acme'])
  assert.deepEqual(await companies({ where: [{ column: 'Phone', operator: 'not_run' }] }), ['Delta', 'MÜNCHEN GmbH'])
  assert.deepEqual(await companies({ where: [{ operator: 'running' }] }), ['Epsilon'])
  assert.deepEqual(await companies({ where: [{ column: 'Phone', operator: 'running' }] }), ['Epsilon'])
  assert.deepEqual(await companies({ where: [{ operator: 'condition_not_met' }] }), ['Gamma'])
  assert.deepEqual(await companies({ where: [{ column: 'Fit (Data)', operator: 'condition_not_met' }] }), ['Gamma'])
  assert.equal(await count([{ operator: 'has_result' }]), 2)
})
await check('OR groups, lists and text that folds beyond ASCII', async () => {
  assert.deepEqual(await companies({ where: [{ or: [
    { column: 'Email', operator: 'has_result' }, { column: 'Fit (Output)', operator: 'eq', value: 'NO' }] }] }),
  ['Acme', 'Zeta'])
  assert.deepEqual(await companies({ where: [{ column: 'Company', operator: 'contains', value: 'münchen' }] }),
    ['MÜNCHEN GmbH'])
  assert.deepEqual(await companies({ where: [
    { column: 'Company', operator: 'not_any_of', values: ['acme', 'beta', 'GAMMA'] }, { operator: 'not_run' }] }),
  ['Delta', 'MÜNCHEN GmbH'])
})
await check('filtered paging keeps its fences', async () => {
  const either = { or: [{ operator: 'not_run' }, { operator: 'has_error' }] }
  const first = await query({ where: [{ operator: 'has_error' }, either], limit: 1 })
  assert.ok('ok' in first)
  const again = await query({ where: [{ column: 'Company', operator: 'not_empty' }], limit: 2 })
  assert.ok('ok' in again && again.ok.next_cursor === 1)
  const unfenced = await query({ where: [{ column: 'Company', operator: 'not_empty' }], cursor: 1 })
  assert.ok('fail' in unfenced && /expected_data_version/.test(unfenced.error))
  const next = await query({ where: [{ column: 'Company', operator: 'not_empty' }], cursor: 1, limit: 2,
    expected_data_version: again.ok.data_version, expected_row_generation: again.ok.row_generation })
  assert.ok('ok' in next)
  assert.deepEqual((next.ok.rows as Array<{ index: number }>).map(r => r.index), [2, 3])
})
await check('include_status: run columns as {status, value, error}, plain columns as they are', async () => {
  const r = await query({ include_status: true, where: [{ column: 'Company', operator: 'eq', value: 'beta' }] })
  assert.ok('ok' in r)
  const data = (r.ok.rows as Array<{ data: Record<string, unknown> }>)[0].data
  assert.equal(data.Company, 'Beta')
  assert.deepEqual(data['Fit (Output)'], { status: 'error', value: null, error: 'Rate limited' })
  assert.deepEqual(data.Email, { status: 'error', value: null, error: 'Timed out' })
  const projected = await query({ include_status: true, columns: ['Email', 'Company'], limit: 1 })
  assert.ok('ok' in projected)
  assert.deepEqual((projected.ok.rows as Array<{ data: unknown }>)[0].data,
    { Email: { status: 'done', value: 'a@acme.com', error: null }, Company: 'Acme' })
  const page = readRowsPage(sid, uid, 4, 2, true)
  assert.deepEqual(page.rows[0].data.Status, { status: 'no_result', value: null, error: null, reason: 'Not found' })
  assert.deepEqual(page.rows[1].data.Email, { status: 'not_run', value: null, error: null })
  assert.equal(readRowsPage(sid, uid, 4, 1).rows[0].data.Status, '⏭️ Not found')
})
await check('refusals say what to do', async () => {
  const run = await query({ where: [{ column: 'Company', operator: 'has_error' }] })
  assert.ok('fail' in run && /"Company" isn't an AI, HTTP API or enrichment column/.test(run.error))
  const ids = await query({ include_status: true, return_mode: 'ids' })
  assert.ok('fail' in ids && /return_mode rows/.test(ids.error))
  const bad = await query({ include_status: 'yes' })
  assert.ok('fail' in bad && /true or false/.test(bad.error))
  db.prepare(`INSERT INTO enrichment_field_jobs (id,user_id,sheet_id,status_column,column_name,json_path)
    VALUES (?,?,?,?,?,?)`).run('job1', uid, sid, 'Status', 'Phone', '$.phone')
  const filling = prepareWhere(sid, uid, [{ operator: 'not_run' }])
  assert.ok('error' in filling && /"Phone" is still filling/.test(filling.error))
  db.prepare("DELETE FROM enrichment_field_jobs WHERE id = 'job1'").run()
})

await check('grid filters: saved, refused, and read as the same SQL', () => {
  const filters = { Email: { type: 'has_error' }, Company: { type: 'contains', value: ' ' } }
  assert.deepEqual(saveColumnFilters(sid, uid, filters), { ok: true })
  const saved = db.prepare('SELECT empty_filter, column_filters FROM sheets WHERE id = ?').get(sid) as
    { empty_filter: string | null; column_filters: string | null }
  assert.equal(saved.column_filters, JSON.stringify({ Email: { type: 'has_error' } }))
  const f = savedFilterSql(sid, uid, { ...saved, empty_filter: JSON.stringify({ Phone: 'empty' }) })!
  const matching = (c: { sql: string; params: unknown[] }) =>
    db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ? AND (${c.sql})`).pluck().all(sid, ...c.params)
  assert.deepEqual(matching(f), [1])
  // A save from before the new operators still reads.
  const before = '{"Company":{"type":"contains","value":"et"}}'
  assert.deepEqual(matching(savedFilterSql(sid, uid, { empty_filter: null, column_filters: before })!), [1, 5])
  const refuse = (raw: unknown, pattern: RegExp) => {
    const r = saveColumnFilters(sid, uid, raw)
    assert.ok('fail' in r && r.fail === 'invalid' && pattern.test(r.error), JSON.stringify(r))
  }
  refuse({ Company: { type: 'has_error' } }, /isn't an AI, HTTP API or enrichment column/)
  refuse({ Nope: { type: 'contains', value: 'x' } }, /unknown column: "Nope"/)
  refuse({ Company: { type: 'any_of', values: [] } }, /columnFilters\["Company"\]: any_of needs values/)
  refuse({ Company: { type: 'gt', value: 'x' } }, /numeric value/)
  refuse([], /must map column names/)
  assert.deepEqual(saveColumnFilters(sid, uid, null), { ok: true })
  assert.equal(savedFilterSql(sid, uid, { empty_filter: null, column_filters: null }), null)
  assert.deepEqual(saveColumnFilters(uuid(), uid, null), { fail: 'not_found', error: 'Sheet not found' })
})

await check('CSV export and transfer scans take the same where', async () => {
  const csv = await buildSheetCsv(sid, uid, { columns: ['Company'], where: [{ operator: 'has_error' }] })
  assert.ok('ok' in csv, JSON.stringify(csv))
  assert.equal(csv.csv, '"Company"\r\n"Beta"')
  const refused = await buildSheetCsv(sid, uid, { where: [{ column: 'Company', operator: 'running' }] })
  assert.ok('fail' in refused && refused.fail === 'invalid')
  const prepared = prepareWhere(sid, uid, [{ or: [{ operator: 'running' }, { operator: 'condition_not_met' }] }])
  assert.ok('ok' in prepared)
  const seen: string[] = []
  const scan = scanTransferRows(sid, uid, { filter: prepared.ok.filter }, rows => seen.push(...rows.map(r => r.id)))
  assert.equal(scan.matched, 2)
  assert.deepEqual(seen, [ids[2], ids[4]])
})

await check('a filtered read in slices finds the rows one query would, across slice edges', async () => {
  const big = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,1,?)')
    .run(big, tid, uid, 'Big', JSON.stringify(['n']))
  const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  // 60,001 rows, numbered with gaps (as after deletes); every third one passes.
  db.transaction(() => {
    for (let i = 0; i <= 60_000; i++) insert.run(uuid(), big, uid, i * 2, JSON.stringify({ n: String(i % 3) }))
  })()
  const prepared = prepareWhere(big, uid, [{ column: 'n', operator: 'eq', value: '0' }])
  assert.ok('ok' in prepared)
  const f = prepared.ok.filter
  const plain = (after: number, skip: number, limit: number) => db.prepare(`SELECT row_index FROM rows
    WHERE sheet_id = ? AND row_index > ? AND (${f.sql}) ORDER BY row_index LIMIT ? OFFSET ?`).pluck()
    .all(big, after, ...f.params, limit, skip)
  for (const [after, skip, limit] of [[-1, 0, 5], [-1, 8_330, 10], [-1, 16_660, 30], [49_990, 0, 12], [-1, 19_990, 50],
    [-1, 20_000, 5], [119_990, 0, 5], [-1, 0, 0]]) {
    const scan = await scanFiltered<{ row_index: number }>(big, uid, f, { after, skip, limit, count: true },
      'row_index')
    assert.deepEqual(scan.rows.map(r => r.row_index), plain(after, skip, limit), JSON.stringify([after, skip, limit]))
    const total = db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND row_index > ? AND (${f.sql})`)
    assert.equal(scan.count, total.pluck().get(big, after, ...f.params))
  }
  const noCount = await scanFiltered(big, uid, f, { after: 30_000, limit: 3 }, 'row_index')
  assert.equal(noCount.count, null)
  assert.deepEqual(noCount.rows.map((r: any) => r.row_index), plain(30_000, 0, 3))
  // read_rows over it: keyset pages that meet end to end.
  const seen: number[] = []
  for (let cursor: number | null = -1; cursor !== null;) {
    const parsed = parseRowQueryBody({ where: [{ column: 'n', operator: 'eq', value: '0' }], limit: 500,
      ...(cursor >= 0 ? { cursor, expected_data_version: 0, expected_row_generation: 0 } : {}) }, 500)
    assert.ok('query' in parsed)
    const r = await queryRows(big, uid, parsed.query)
    assert.ok('ok' in r, JSON.stringify(r))
    seen.push(...(r.ok.rows as Array<{ index: number }>).map(x => x.index))
    cursor = r.ok.next_cursor as number | null
  }
  assert.equal(seen.length, 20_001)
  assert.deepEqual(seen.slice(0, 3), [0, 6, 12])

  // A sort finishing between slices: a fenced page says restart; a first page reads again.
  const where = [{ column: 'n', operator: 'eq', value: '0' }]
  const bump = () => setImmediate(() =>
    db.prepare('UPDATE sheets SET row_generation = row_generation + 1 WHERE id = ?').run(big))
  const g = (db.prepare('SELECT data_version, row_generation FROM sheets WHERE id = ?').get(big)) as
    { data_version: number; row_generation: number }
  // (A filter nothing passes, so the page walks every slice.)
  const fenced = parseRowQueryBody({ where: [{ column: 'n', operator: 'eq', value: '7' }], cursor: 0, limit: 5,
    expected_data_version: g.data_version, expected_row_generation: g.row_generation }, 500)
  assert.ok('query' in fenced)
  bump()
  const conflict = await queryRows(big, uid, fenced.query)
  assert.ok('fail' in conflict && conflict.fail === 'version_conflict', JSON.stringify(conflict))
  const first = parseRowQueryBody({ where, return_mode: 'count' }, 500)
  assert.ok('query' in first)
  bump()
  const again = await queryRows(big, uid, first.query)
  assert.ok('ok' in again && again.ok.count === 20_001 && again.ok.row_generation === g.row_generation + 2,
    JSON.stringify(again))

  // A heavy job moving rows mid-scan (parked above every position, as a sort's
  // first pass does): the scan is read again in one go, each row once.
  setImmediate(() => void busyMod.withSheetBusy(big, 'sorting', async () => {
    db.prepare('UPDATE rows SET row_index = row_index + 1000000 WHERE sheet_id = ?').run(big)
    await new Promise(r => setTimeout(r, 30))
    db.prepare('UPDATE rows SET row_index = row_index - 1000000 WHERE sheet_id = ?').run(big)
  }))
  const counted = await scanFiltered(big, uid, f, { limit: 0, count: true }, 'row_index')
  assert.equal(counted.count, 20_001)
})

await check('a filter saved before a column stopped being a run column does not block other saves', () => {
  assert.deepEqual(saveColumnFilters(sid, uid, { Email: { type: 'has_error' } }), { ok: true })
  db.prepare(`UPDATE http_column_associations SET extracted_column_name = 'Gone'
    WHERE sheet_id = ? AND extracted_column_name = 'Email'`).run(sid)
  const both = { Email: { type: 'has_error' }, Company: { type: 'contains', value: 'a' } }
  assert.deepEqual(saveColumnFilters(sid, uid, both), { ok: true })
  const fresh = saveColumnFilters(sid, uid, { Email: { type: 'running' } })
  assert.ok('fail' in fresh && /isn't an AI, HTTP API or enrichment column/.test(fresh.error))
  assert.deepEqual(saveColumnFilters(sid, uid, null), { ok: true })
})

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nAll row-query assertions passed.')

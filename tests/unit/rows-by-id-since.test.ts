// Over 200 lines: one fixture (run columns with failures, a second sheet, a deleted row) shared by both reads.
// read_rows / REST rows/query `row_ids` and `updated_since` through the real
// services on a migrated throwaway DB. row_ids: the rows in the order asked,
// `missing` for ids that are no row of this sheet (never one, deleted, another
// sheet's), columns, include_status with each failed cell's full error from
// its run's result (a page read keeps the cell's own words), MCP's character
// cap. updated_since: inclusive whole seconds, paging across a cursor through
// rows sharing one second, a walk ending at its first page's time, as_of for
// the next walk, deleted rows gone, the index used (no scan, no sort). And
// every refusal.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import selMod from '../../server/src/services/row-selection'
import readMod from '../../server/src/services/workspace-read'
import trashMod from '../../server/src/services/trash-rows'
import sinceMod from '../../server/src/services/rows-since'
import byIdMod from '../../server/src/services/rows-by-id'
import timeMod from '../../server/src/lib/row-since'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { queryRows, parseRowQueryBody } = selMod as typeof import('../../server/src/services/row-selection')
const { readRowsPage } = readMod as typeof import('../../server/src/services/workspace-read')
const { deleteRowsToTrash } = trashMod as typeof import('../../server/src/services/trash-rows')
const { ROWS_SINCE_SQL } = sinceMod as typeof import('../../server/src/services/rows-since')
const { ROWS_BY_ID_SQL } = byIdMod as typeof import('../../server/src/services/rows-by-id')
const { parseSinceTime, decodeSinceCursor, encodeSinceCursor } =
  timeMod as typeof import('../../server/src/lib/row-since')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(columns: string[], rows: Array<Record<string, string>>) {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(columns))
  const ids = rows.map((data, i) => {
    const id = uuid()
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(id, sid, uid, i, JSON.stringify(data))
    return id
  })
  return { sid, ids }
}

// An HTTP API column (Ping, output Code), an enrichment (Status, output Email)
// with two runs, and an AI column with its "(Data)" column. Row 1 failed in all.
const COLUMNS = ['Company', 'Ping', 'Code', 'Status', 'Email', 'Fit (Output)', 'Fit (Data)']
const LONG = `Provider said: ${'the lookup service could not find a verified address for this domain; '.repeat(4)}`
const cut = `❌ ${LONG.slice(0, 119)}…`
const S = sheet(COLUMNS, [
  { Company: 'Acme', Ping: '✅ 200', Code: '200', Status: '✅ Found', Email: 'a@acme.com', 'Fit (Output)': 'yes' },
  { Company: 'Beta', Ping: '❌ Failed', Code: '❌ Error', Status: cut, Email: '', 'Fit (Output)': '❌ Error: Rate limited',
    'Fit (Data)': '❌ Error' },
  { Company: 'Gamma' }, { Company: 'Delta' }, { Company: 'Epsilon' },
])
const run = (column: string, config: unknown) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?, 'completed', ?)`).run(id, S.sid, uid, JSON.stringify(config), column)
  return id
}
const link = (master: string, out: string, runId: string) => db.prepare(`INSERT INTO http_column_associations
  (id,sheet_id,user_id,master_column_name,extracted_column_name,run_id) VALUES (?,?,?,?,?,?)`)
  .run(uuid(), S.sid, uid, master, out, runId)
const result = (runId: string, row: number, status: string, error: string | null, undone = 0) => db.prepare(
  `INSERT INTO http_results (id,run_id,user_id,row_index,status,error_message,undone) VALUES (?,?,?,?,?,?,?)`,
).run(uuid(), runId, uid, row, status, error, undone)
const ping = run('Ping', { responseMapping: [{ columnName: 'Code', jsonPath: '$.code' }] })
link('Ping', 'Code', ping)
result(ping, 0, 'completed', null)
result(ping, 1, 'failed', 'HTTP 503 Service Unavailable: the upstream timed out after 30 s')
const older = run('Status', { enrichment: { v: 1 } })
const newer = run('Status', { enrichment: { v: 1 } })
for (const r of [older, newer]) link('Status', 'Email', r)
result(older, 1, 'failed', 'An older run failed here')
result(newer, 1, 'failed', LONG)
result(newer, 2, 'failed', 'Undone since', 1)
const ai = uuid()
db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,use_openrouter_web_search)
  VALUES (?,?,?,'Fit (Output)','p','completed',1)`).run(ai, S.sid, uid)
db.prepare(`INSERT INTO ai_results (id,run_id,user_id,row_index,status,error_message) VALUES (?,?,?,1,'failed',?)`)
  .run(uuid(), ai, uid, 'Rate limited')
const OTHER = sheet(['Company'], [{ Company: 'Elsewhere' }])

const query = async (body: Record<string, unknown>, sid = S.sid, maxChars?: number) => {
  const parsed = parseRowQueryBody(body, 500)
  if ('error' in parsed) return { fail: 'invalid', error: parsed.error } as const
  return queryRows(sid, uid, { ...parsed.query, ...(maxChars ? { maxChars } : {}) })
}
type Row = { id: string; index: number; updated_at: string; data: Record<string, unknown> }
const okRows = async (body: Record<string, unknown>, sid = S.sid) => {
  const r = await query(body, sid)
  assert.ok('ok' in r, JSON.stringify(r))
  return r.ok as { rows: Row[]; missing?: string[]; next_cursor?: string | null; as_of?: string }
}
const refused = async (body: Record<string, unknown>, pattern: RegExp) => {
  const r = await query(body)
  assert.ok('fail' in r && pattern.test(r.error), JSON.stringify(r))
}

async function main() {
  const gone = S.ids[4]
  db.transaction(() => deleteRowsToTrash(S.sid, uid, 'grid', { indexes: [4] }))()

  await check('row_ids: the rows in the order asked, and missing for every id that is no row here', async () => {
    const asked = [S.ids[3], S.ids[0], 'no-such-row', gone, OTHER.ids[0], S.ids[2]]
    const r = await okRows({ row_ids: asked })
    assert.deepEqual(r.rows.map(x => x.id), [S.ids[3], S.ids[0], S.ids[2]])
    assert.deepEqual(r.rows.map(x => x.index), [3, 0, 2])
    assert.deepEqual(r.missing, ['no-such-row', gone, OTHER.ids[0]])
    assert.ok(r.rows.every(x => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(x.updated_at)), JSON.stringify(r.rows))
    assert.deepEqual(r.rows[1].data, { Company: 'Acme', Ping: '✅ 200', Code: '200', Status: '✅ Found',
      Email: 'a@acme.com', 'Fit (Output)': 'yes' })
    const only = await okRows({ row_ids: [S.ids[1]], columns: ['Company', { column: 'Code', as: 'C' }] })
    assert.deepEqual(only.rows[0].data, { Company: 'Beta', C: '❌ Error' })
  })

  await check('row_ids with include_status: a failed cell says the full error its run recorded', async () => {
    const r = await okRows({ row_ids: [S.ids[1]], include_status: true })
    const d = r.rows[0].data as Record<string, { status: string; error: string | null }>
    const full = 'HTTP 503 Service Unavailable: the upstream timed out after 30 s'
    assert.deepEqual([d.Ping.error, d.Code.error], [full, full])
    assert.equal(d.Status.error, LONG, 'the newest run with a result at the row')
    assert.equal(d.Email.status, 'error')
    assert.equal(d.Email.error, LONG)
    assert.deepEqual([d['Fit (Output)'].error, d['Fit (Data)'].error], ['Rate limited', 'Rate limited'])
    // A page read keeps the cell's own words, as before.
    const page = readRowsPage(S.sid, uid, 0, 1, true).rows[0].data as typeof d
    assert.deepEqual([page.Ping.error, page.Code.error, page['Fit (Data)'].error], ['Failed', 'Error', 'Error'])
    assert.equal(page.Status.error, cut.slice(2))
    const filtered = await okRows({ where: [{ column: 'Code', operator: 'has_error' }], include_status: true })
    assert.equal((filtered.rows[0].data.Code as { error: string }).error, 'Error')
  })

  await check('row_ids: an undone result is skipped, and a cell no run failed keeps its words', async () => {
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Status', '❌ Typed by hand') WHERE id = ?`).run(S.ids[2])
    const r = await okRows({ row_ids: [S.ids[2]], include_status: true, columns: ['Status'] })
    assert.deepEqual(r.rows[0].data.Status, { status: 'error', value: null, error: 'Typed by hand' })
  })

  await check('row_ids over MCP stop at the character cap and list the rest in unread_ids', async () => {
    const r = await query({ row_ids: [S.ids[0], S.ids[1], S.ids[2]] }, S.sid, 300)
    assert.ok('ok' in r, JSON.stringify(r))
    assert.deepEqual((r.ok.rows as Row[]).map(x => x.id), [S.ids[0]])
    assert.deepEqual(r.ok.unread_ids, [S.ids[1], S.ids[2]])
    const all = await query({ row_ids: [S.ids[0]] }, S.sid, 10)
    assert.ok('ok' in all && (all.ok.rows as Row[]).length === 1 && all.ok.unread_ids === undefined)
  })

  // A sheet whose rows changed at known times: five in one second, two later.
  const U = sheet(['Name'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(Name => ({ Name })))
  const at = (i: number, t: string) => db.prepare('UPDATE rows SET updated_at = ? WHERE id = ?').run(t, U.ids[i])
  U.ids.forEach((_, i) => at(i, i < 5 ? '2026-01-01 10:00:00' : '2026-01-01 10:00:05'))
  const names = (rows: Row[]) => rows.map(r => r.data.Name).join('')

  await check('updated_since pages through rows sharing a second, in (updated_at, rowid) order', async () => {
    const seen: Row[] = []
    let cursor: string | undefined, asOf: string | undefined, pages = 0
    do {
      const r = await okRows({ updated_since: '2026-01-01T10:00:00Z', limit: 2, ...(cursor ? { cursor } : {}) }, U.sid)
      seen.push(...r.rows)
      asOf ??= r.as_of
      assert.equal(r.as_of, asOf, 'every page of a walk answers the as_of of its first')
      cursor = r.next_cursor ?? undefined
      pages++
    } while (cursor)
    assert.equal(names(seen), 'abcdefg')
    assert.equal(pages, 4)
    assert.deepEqual(seen.map(r => r.updated_at).slice(4), ['2026-01-01T10:00:00Z', '2026-01-01T10:00:05Z',
      '2026-01-01T10:00:05Z'])
  })

  await check('updated_since is inclusive by the second, in either format, with a fraction or an offset', async () => {
    for (const since of ['2026-01-01T10:00:01Z', '2026-01-01 10:00:05', '2026-01-01T10:00:05.900Z',
      '2026-01-01T11:00:05+01:00', '2026-01-01T05:00:05-05:00']) {
      assert.equal(names((await okRows({ updated_since: since }, U.sid)).rows), 'fg', since)
    }
    assert.equal(names((await okRows({ updated_since: '2026-01-01T10:00:06Z' }, U.sid)).rows), '')
  })

  await check('a walk ends at its first page; rows changed meanwhile come in the next walk from as_of', async () => {
    const first = await okRows({ updated_since: '2026-01-01T10:00:00Z', limit: 3, columns: ['Name'] }, U.sid)
    assert.equal(names(first.rows), 'abc')
    const walk = decodeSinceCursor(first.next_cursor!)!
    const back = db.prepare("SELECT datetime(?, '-10 seconds')").pluck().get(walk.until) as string
    assert.equal(walk.asOf, back, 'as_of is the slack before the walk started')
    assert.equal(first.as_of, `${back.replace(' ', 'T')}Z`)
    // Edits in a later second than the walk's start (as the app's autosave writes them).
    while ((db.prepare("SELECT datetime('now')").pluck().get() as string) <= walk.until) {
      await new Promise(r => setTimeout(r, 50))
    }
    const edit = (i: number, v: string) => db.prepare(`UPDATE rows SET data = json_set(data, '$.Name', ?),
      updated_at = datetime('now') WHERE id = ?`).run(v, U.ids[i])
    edit(0, 'A')
    edit(6, 'G')
    const rest = await okRows({ updated_since: '2026-01-01T10:00:00Z', cursor: first.next_cursor, limit: 10 }, U.sid)
    assert.equal(names(rest.rows), 'def', 'G moved past the walk\'s end, A was read already')
    assert.equal(rest.next_cursor, null)
    const next = await okRows({ updated_since: first.as_of }, U.sid)
    assert.equal(names(next.rows), 'AG')
  })

  await check('deleted rows do not come back; a time ahead answers nothing with as_of = that time', async () => {
    db.transaction(() => deleteRowsToTrash(U.sid, uid, 'grid', { indexes: [1] }))()
    const r = await okRows({ updated_since: '2026-01-01T10:00:00Z' }, U.sid)
    assert.ok(!r.rows.some(x => x.id === U.ids[1]))
    const ahead = await okRows({ updated_since: '2099-01-01T00:00:00Z' }, U.sid)
    assert.deepEqual([ahead.rows.length, ahead.as_of, ahead.next_cursor], [0, '2099-01-01T00:00:00Z', null])
  })

  await check('updated_since reads through the (sheet_id, updated_at) index: no scan, no sort', () => {
    // A first page (from a second's rowid 0) and a later one, as a walk asks.
    const plan = () => [['2026-01-01 10:00:00', 0], ['2026-01-01 10:00:00', 3]].map(([t, r]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${ROWS_SINCE_SQL}`).all(U.sid, uid, t, r, '2026-12-01 00:00:00', 5) as
        Array<{ detail: string }>).map(p => p.detail).join(' | ')).join(' || ')
    // By id: the primary key (on a table this small, statistics would rightly pick a scan).
    const byId = (db.prepare(`EXPLAIN QUERY PLAN ${ROWS_BY_ID_SQL}`).all('[]', U.sid, uid) as
      Array<{ detail: string }>).map(p => p.detail).join(' | ')
    assert.match(byId, /SEARCH rows USING INDEX sqlite_autoindex_\w+ \(id=\?\)/, byId)
    for (const label of ['without statistics', 'after ANALYZE']) {
      const p = plan()
      assert.match(p, /SEARCH rows USING INDEX idx_rows_sheet_updated \(sheet_id=\? AND \(updated_at,rowid\)>/,
        `${label}: ${p}`)
      assert.doesNotMatch(p, /TEMP B-TREE|SCAN/, `${label}: ${p}`)
      db.exec('ANALYZE')
    }
  })

  await check('row_ids refusals', async () => {
    const one = [S.ids[0]]
    await refused({ row_ids: one, where: [{ column: 'Company', operator: 'not_empty' }] }, /leave out where/)
    await refused({ row_ids: one, view: 'Default' }, /leave out view/)
    await refused({ row_ids: one, cursor: 0 }, /leave out cursor/)
    await refused({ row_ids: one, limit: 5 }, /leave out limit/)
    await refused({ row_ids: one, return_mode: 'ids' }, /leave out return_mode/)
    await refused({ row_ids: one, group_by: ['Company'] }, /leave out group_by and aggregates/)
    await refused({ row_ids: one, expected_data_version: 1 }, /leave out expected_data_version/)
    await refused({ row_ids: one, updated_since: '2026-01-01T00:00:00Z' }, /two different reads/)
    await refused({ row_ids: [] }, /1 to 1000 row ids/)
    await refused({ row_ids: Array.from({ length: 1001 }, (_, i) => `id${i}`) }, /1 to 1000 row ids/)
    await refused({ row_ids: [S.ids[0], S.ids[0]] }, /twice/)
    await refused({ row_ids: [S.ids[0], 7] }, /list of row ids/)
    await refused({ row_ids: S.ids[0] }, /list of row ids/)
    await refused({ row_ids: one, columns: ['Nope'] }, /Unknown column/)
  })

  await check('updated_since refusals', async () => {
    const since = '2026-01-01T10:00:00Z'
    await refused({ updated_since: since, where: [{ column: 'Company', operator: 'not_empty' }] }, /leave out where/)
    await refused({ updated_since: since, view: 'Default' }, /leave out view/)
    await refused({ updated_since: since, group_by: ['Company'] }, /leave out group_by/)
    await refused({ updated_since: since, return_mode: 'count' }, /leave out return_mode/)
    await refused({ updated_since: since, cursor: 3 }, /a number cursor/)
    await refused({ updated_since: since, cursor: 'garbage' }, /start again without cursor/)
    const other = encodeSinceCursor({ since: '2026-01-02 00:00:00', t: '2026-01-02 00:00:00', r: 1,
      until: '2026-01-03 00:00:00', asOf: '2026-01-02 00:00:00' })
    await refused({ updated_since: since, cursor: other }, /from another time/)
    await refused({ cursor: other }, /send it with the same updated_since/)
    for (const bad of ['2026-01-01', '2026-01-01T10:00:00', '2026-13-01 00:00:00', '2026-02-30T00:00:00Z',
      'yesterday', '2026-01-01 10:00', '1700000000']) await refused({ updated_since: bad }, /updated_since must be/)
    await refused({ updated_since: 1700000000 }, /updated_since must be/)
    await refused({ updated_since: since, limit: 501 }, /limit must be/)
  })

  await check('the time and cursor helpers', () => {
    assert.deepEqual(parseSinceTime('2026-11-05T10:00:00Z'), { sql: '2026-11-05 10:00:00' })
    assert.deepEqual(parseSinceTime(' 2026-11-05 10:00:00 '), { sql: '2026-11-05 10:00:00' })
    assert.deepEqual(parseSinceTime('2026-11-05T00:30:00+01:00'), { sql: '2026-11-04 23:30:00' })
    assert.ok('error' in parseSinceTime('2026-11-05T10:00:00+25:00'))
    const c = { since: '2026-11-05 10:00:00', t: '2026-11-05 10:00:01', r: 42, until: '2026-11-05 11:00:00',
      asOf: '2026-11-05 10:59:50' }
    assert.deepEqual(decodeSinceCursor(encodeSinceCursor(c)), c)
    assert.equal(decodeSinceCursor(Buffer.from('[1,"x"]').toString('base64url')), null)
  })

  if (failures > 0) { console.error(`${failures} rows-by-id-since assertion(s) failed`); process.exit(1) }
  console.log('All rows-by-id-since assertions passed.')
}
main().catch(e => { console.error(e); process.exit(1) })

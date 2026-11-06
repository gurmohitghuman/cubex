// Over 200 lines: one fixture (long cells, a JSON cell, an emoji row, an HTTP API run that failed) read every way.
// read_rows / REST rows/query `max_chars_per_cell` through the real services
// on a migrated throwaway DB: long cells cut and listed in truncated_cells
// (row_id, column, full_length) in row order, short ones untouched, an emoji
// never split; without it the answer has no truncated_cells and the same rows;
// the bounds refused with the limits in the words, on the REST body and on the
// query MCP builds; groups and counts refused. Every read of rows: a page, a
// filtered page and the next one, columns with JSON paths (text, object,
// number), include_status (value or error cut, never status), row_ids (MCP's
// character cap counting the cut rows), updated_since and a view.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import selMod from '../../server/src/services/row-selection'
import viewsMod from '../../server/src/services/views'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { queryRows, parseRowQueryBody } = selMod as typeof import('../../server/src/services/row-selection')
const { createView } = viewsMod as typeof import('../../server/src/services/views')

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

// Ping is an HTTP API column filling Code; its run failed at row 1 with a long error.
const DATA = { bio: 'b'.repeat(300), emails: ['a@acme.com'], n: 12345 }
const JSON_TEXT = JSON.stringify({ data: DATA })
const EMOJI = `ab${'😀'.repeat(10)}` // 22 code units
const LONG_ERROR = `HTTP 503 Service Unavailable: ${'the upstream timed out; '.repeat(4)}`
const S = sheet(['Name', 'Notes', 'Json', 'Ping', 'Code'], [
  { Name: 'Acme', Notes: 'n'.repeat(300), Json: JSON_TEXT, Ping: '✅ 200', Code: 'c'.repeat(50) },
  { Name: 'Beta', Notes: EMOJI, Ping: '❌ Failed', Code: '❌ Error' },
  { Name: 'Gamma', Notes: 'short' },
  { Name: 'Delta' },
])
const [r0, r1, r2] = S.ids
const ping = uuid()
db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
  VALUES (?,?,?,?, 'completed', 'Ping')`)
  .run(ping, S.sid, uid, JSON.stringify({ responseMapping: [{ columnName: 'Code', jsonPath: '$.code' }] }))
db.prepare(`INSERT INTO http_column_associations
  (id,sheet_id,user_id,master_column_name,extracted_column_name,run_id) VALUES (?,?,?,'Ping','Code',?)`)
  .run(uuid(), S.sid, uid, ping)
db.prepare(`INSERT INTO http_results (id,run_id,user_id,row_index,status,error_message) VALUES (?,?,?,1,'failed',?)`)
  .run(uuid(), ping, uid, LONG_ERROR)

type Row = { id: string; data: Record<string, any> }
type Cut = { row_id: string; column: string; full_length: number }
type Answer = { rows: Row[]; truncated_cells?: Cut[]; [k: string]: unknown }
// As REST reads a body; `extra` is what MCP adds to the query it builds (maxChars, or a raw maxCharsPerCell).
const query = async (body: Record<string, unknown>, extra: Record<string, unknown> = {}, sid = S.sid) => {
  const parsed = parseRowQueryBody(body, 500)
  if ('error' in parsed) return { fail: 'invalid', error: parsed.error } as const
  return queryRows(sid, uid, { ...parsed.query, ...extra })
}
const okRead = async (body: Record<string, unknown>, extra: Record<string, unknown> = {}, sid = S.sid) => {
  const r = await query(body, extra, sid)
  assert.ok('ok' in r, JSON.stringify(r))
  return r.ok as Answer
}
const refusal = async (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const r = await query(body, extra)
  assert.ok('fail' in r, JSON.stringify(r))
  return r.error
}
const BOUNDS = 'max_chars_per_cell must be an integer from 1 to 200000.'

async function main() {
  await check('a page: long cells cut to N, short ones as they are, truncated_cells in row order', async () => {
    const r = await okRead({ max_chars_per_cell: 10 })
    assert.deepEqual(r.rows[0].data, { Name: 'Acme', Notes: 'n'.repeat(10), Json: JSON_TEXT.slice(0, 10),
      Ping: '✅ 200', Code: 'c'.repeat(10) })
    assert.equal(r.rows[1].data.Notes, `ab${'😀'.repeat(4)}`)
    assert.deepEqual(r.rows[2].data, { Name: 'Gamma', Notes: 'short' })
    assert.deepEqual(r.truncated_cells, [
      { row_id: r0, column: 'Notes', full_length: 300 }, { row_id: r0, column: 'Json', full_length: JSON_TEXT.length },
      { row_id: r0, column: 'Code', full_length: 50 }, { row_id: r1, column: 'Notes', full_length: 22 },
    ])
    assert.deepEqual(Object.keys(r), ['rows', 'truncated_cells', 'next_cursor', 'data_version', 'row_generation'])
    // An odd N would end on an emoji's first half: one fewer, never half of it.
    const odd = await okRead({ max_chars_per_cell: 11 })
    assert.equal(odd.rows[1].data.Notes, `ab${'😀'.repeat(4)}`)
    assert.equal((await okRead({ max_chars_per_cell: 1 })).rows[1].data.Notes, 'a')
  })

  await check('without max_chars_per_cell: no truncated_cells, and the same answer otherwise', async () => {
    const shapes: Array<Record<string, unknown>> = [
      {}, { include_status: true }, { where: [{ column: 'Notes', operator: 'not_empty' }], limit: 2 },
      { columns: ['Name', { column: 'Json', path: ['data', 'bio'], as: 'Bio' }] }, { row_ids: [r1, r0] },
      { row_ids: [r1], include_status: true }, { updated_since: '2000-01-01T00:00:00Z' },
    ]
    for (const body of shapes) {
      const plain = await okRead(body)
      assert.ok(!('truncated_cells' in plain), JSON.stringify(body))
      // A cut no cell reaches: the same rows, plus an empty truncated_cells.
      const wide = await okRead({ ...body, max_chars_per_cell: 200_000 })
      assert.deepEqual(wide.truncated_cells, [], JSON.stringify(body))
      const { truncated_cells: _, ...rest } = wide
      assert.deepEqual({ ...rest, as_of: undefined }, { ...plain, as_of: undefined }, JSON.stringify(body))
    }
  })

  await check('the bounds: 1 to 200000; anything else refused with the limits, on REST and over MCP', async () => {
    for (const bad of [0, -1, 200_001, 2.5, '10', null, true, [10]]) {
      assert.equal(await refusal({ max_chars_per_cell: bad }), BOUNDS, `REST ${JSON.stringify(bad)}`)
    }
    // MCP hands the number it got straight to the query: the same words.
    for (const bad of [0, 200_001, 2.5, Number.NaN]) {
      assert.equal(await refusal({}, { maxCharsPerCell: bad }), BOUNDS, `MCP ${bad}`)
      assert.equal(await refusal({ row_ids: [r0] }, { maxCharsPerCell: bad }), BOUNDS, `MCP by id ${bad}`)
    }
    assert.ok((await okRead({ max_chars_per_cell: 200_000 })).rows.length === 4)
  })

  await check('groups and counts return no cells: refused with what to leave out', async () => {
    assert.equal(await refusal({ group_by: ['Name'], max_chars_per_cell: 10 }),
      'group_by and aggregates answer groups, not rows: leave out max_chars_per_cell.')
    assert.equal(await refusal({ aggregates: [{ op: 'count' }], max_chars_per_cell: 10 }),
      'group_by and aggregates answer groups, not rows: leave out max_chars_per_cell.')
    for (const mode of ['count', 'ids']) {
      assert.equal(await refusal({ return_mode: mode, max_chars_per_cell: 10 }),
        'max_chars_per_cell works with return_mode rows only')
    }
  })

  await check('a filtered read and its next page: each page lists its own cut cells', async () => {
    const where = [{ column: 'Notes', operator: 'not_empty' }]
    const first = await okRead({ where, limit: 1, max_chars_per_cell: 10 })
    assert.deepEqual(first.rows.map(r => r.id), [r0])
    assert.deepEqual(first.truncated_cells!.map(c => c.row_id), [r0, r0, r0])
    const next = await okRead({ where, limit: 2, cursor: first.next_cursor, max_chars_per_cell: 10,
      expected_data_version: first.data_version, expected_row_generation: first.row_generation })
    assert.deepEqual(next.rows.map(r => r.id), [r1, r2])
    assert.deepEqual(next.truncated_cells, [{ row_id: r1, column: 'Notes', full_length: 22 }])
  })

  await check('columns with JSON paths: text cut, an object cut as its JSON text, a number as it is', async () => {
    const r = await okRead({ max_chars_per_cell: 20, columns: ['Name', { column: 'Json', path: ['data', 'bio'],
      as: 'Bio' }, { column: 'Json', path: ['data'] }, { column: 'Json', path: ['data', 'n'], as: 'N' },
    { column: 'Json', path: ['data', 'emails', 0], as: 'Email' }] })
    const whole = JSON.stringify(DATA)
    assert.deepEqual(r.rows[0].data, { Name: 'Acme', Bio: 'b'.repeat(20), 'Json.data': whole.slice(0, 20), N: 12345,
      Email: 'a@acme.com' })
    assert.deepEqual(r.rows[1].data, { Name: 'Beta', Bio: null, 'Json.data': null, N: null, Email: null })
    assert.deepEqual(r.truncated_cells, [{ row_id: r0, column: 'Bio', full_length: 300 },
      { row_id: r0, column: 'Json.data', full_length: whole.length }])
    // An object that fits stays an object.
    const fits = await okRead({ max_chars_per_cell: 2000, columns: [{ column: 'Json', path: ['data'], as: 'D' }] })
    assert.deepEqual(fits.rows[0].data.D, DATA)
  })

  await check('include_status: a run cell\'s value or error cut, never its status; other columns as text', async () => {
    const r = await okRead({ include_status: true, max_chars_per_cell: 5 })
    assert.deepEqual(r.rows[0].data.Ping, { status: 'done', value: '✅ 200', error: null })
    assert.deepEqual(r.rows[0].data.Code, { status: 'done', value: 'ccccc', error: null })
    assert.equal(r.rows[0].data.Notes, 'nnnnn')
    assert.deepEqual(r.rows[1].data.Ping, { status: 'error', value: null, error: 'Faile' })
    assert.deepEqual(r.rows[1].data.Code, { status: 'error', value: null, error: 'Error' })
    assert.deepEqual(r.truncated_cells!.filter(c => c.row_id === r1),
      [{ row_id: r1, column: 'Notes', full_length: 22 }, { row_id: r1, column: 'Ping', full_length: 6 }])
    // A read by id says the run's whole error: that is what gets cut.
    const byId = await okRead({ row_ids: [r1], include_status: true, columns: ['Ping'], max_chars_per_cell: 20 })
    assert.deepEqual(byId.rows[0].data.Ping, { status: 'error', value: null, error: LONG_ERROR.slice(0, 20) })
    assert.deepEqual(byId.truncated_cells, [{ row_id: r1, column: 'Ping', full_length: LONG_ERROR.length }])
    // A run column picked under another name is still a run cell.
    const named = await okRead({ include_status: true, columns: [{ column: 'Code', as: 'C' }], max_chars_per_cell: 5 })
    assert.deepEqual(named.rows[0].data.C, { status: 'done', value: 'ccccc', error: null })
    assert.deepEqual(named.truncated_cells, [{ row_id: r0, column: 'C', full_length: 50 }])
  })

  await check('row_ids: the order asked; over MCP the cut rows fill the character cap', async () => {
    const r = await okRead({ row_ids: [r1, r0], columns: ['Notes'], max_chars_per_cell: 10 })
    assert.deepEqual(r.truncated_cells, [{ row_id: r1, column: 'Notes', full_length: 22 },
      { row_id: r0, column: 'Notes', full_length: 300 }])
    assert.deepEqual(Object.keys(r), ['rows', 'truncated_cells', 'missing', 'data_version', 'row_generation'])
    const W = sheet(['Answer'], Array.from({ length: 30 }, (_, i) => ({ Answer: `${i}`.padEnd(3000, 'x') })))
    const whole = await okRead({ row_ids: W.ids }, { maxChars: 40_000 }, W.sid)
    assert.ok(whole.rows.length < 15 && (whole.unread_ids as string[]).length > 15, `${whole.rows.length} rows`)
    const cut = await okRead({ row_ids: W.ids, max_chars_per_cell: 100 }, { maxChars: 40_000 }, W.sid)
    assert.equal(cut.rows.length, 30)
    assert.equal(cut.unread_ids, undefined)
    assert.equal(cut.truncated_cells!.length, 30)
    // The cap counts the truncated_cells entries too, and lists only the rows returned.
    const tight = await okRead({ row_ids: W.ids, max_chars_per_cell: 100 }, { maxChars: 1_000 }, W.sid)
    assert.ok(tight.rows.length < 10, `${tight.rows.length} rows`)
    assert.ok(JSON.stringify({ rows: tight.rows, truncated_cells: tight.truncated_cells }).length < 1_300)
    assert.deepEqual(tight.truncated_cells!.map(c => c.row_id), tight.rows.map(row => row.id))
    assert.equal((tight.unread_ids as string[]).length, 30 - tight.rows.length)
  })

  await check('updated_since: the cells as rows hold them, cut', async () => {
    const r = await okRead({ updated_since: '2000-01-01T00:00:00Z', columns: ['Notes'], max_chars_per_cell: 4 })
    assert.deepEqual(r.rows.map(row => row.data.Notes), ['nnnn', 'ab😀', 'shor', ''])
    assert.deepEqual(r.truncated_cells!.map(c => [c.row_id, c.column, c.full_length]),
      [[r0, 'Notes', 300], [r1, 'Notes', 22], [r2, 'Notes', 5]])
    assert.deepEqual(Object.keys(r), ['rows', 'truncated_cells', 'next_cursor', 'as_of', 'filling', 'data_version',
      'row_generation'])
  })

  await check('a view: its filter kept, only its visible columns read and cut, view_version answered', async () => {
    const made = createView(S.sid, uid, { name: 'Notes only', where: [{ column: 'Notes', operator: 'not_empty' }],
      hidden_columns: ['Json', 'Code'] })
    assert.ok('ok' in made, JSON.stringify(made))
    const r = await okRead({ view: 'Notes only', max_chars_per_cell: 10 })
    assert.deepEqual(r.rows.map(row => row.id), [r0, r1, r2])
    assert.deepEqual(Object.keys(r.rows[0].data), ['Name', 'Notes', 'Ping'])
    assert.deepEqual(r.truncated_cells, [{ row_id: r0, column: 'Notes', full_length: 300 },
      { row_id: r1, column: 'Notes', full_length: 22 }])
    assert.equal(typeof r.view_version, 'string')
  })

  if (failures) { console.error(`${failures} read-max-chars check(s) failed`); process.exit(1) }
  console.log('All read-max-chars assertions passed.')
}

main().catch(e => { console.error(e); process.exit(1) })

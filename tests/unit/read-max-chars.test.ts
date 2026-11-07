// Over 200 lines: one fixture (long cells, a JSON cell, an emoji row, an HTTP API run that failed) read every way.
// read_rows / REST rows/query `max_chars_per_cell` through the real services
// on a migrated throwaway DB: long cells cut and listed in truncated_cells
// ({"<row id>": {"<column>": full length}}, rows and columns in the answer's
// order), short ones untouched, an emoji never split; without it the answer has
// no truncated_cells and the same rows; the bounds refused with the limits in
// the words, on the REST body (digits sent as text the number) and on the query
// MCP builds; groups and counts refused in one round. Every read of rows: a
// page, a filtered page and the
// next one, columns with JSON paths (text, object, number), include_status
// (value or error cut, never status; a path pick on a run column and a column
// picked under a run column's name cut as values), row_ids (MCP's character cap
// counting each row with its entry, one row always back) and updated_since and
// a view. The answers as MCP and REST send them: tests/unit/read-max-chars-surfaces.test.ts.
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
type Cuts = Record<string, Record<string, number>>
type Answer = { rows: Row[]; truncated_cells?: Cuts; [k: string]: unknown }
// The answer as it goes out (JSON): truncated_cells' null-prototype objects become plain ones.
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x))
// As REST reads a body; `extra` is what MCP adds to the query it builds (maxChars, or a raw maxCharsPerCell).
const query = async (body: Record<string, unknown>, extra: Record<string, unknown> = {}, sid = S.sid) => {
  const parsed = parseRowQueryBody(body, 500)
  if ('error' in parsed) return { fail: 'invalid', error: parsed.error } as const
  return queryRows(sid, uid, { ...parsed.query, ...extra })
}
const okRead = async (body: Record<string, unknown>, extra: Record<string, unknown> = {}, sid = S.sid) => {
  const r = await query(body, extra, sid)
  assert.ok('ok' in r, JSON.stringify(r))
  return wire(r.ok) as Answer
}
const refusal = async (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const r = await query(body, extra)
  assert.ok('fail' in r, JSON.stringify(r))
  return r.error
}
// truncated_cells' rows, then each row's columns, in order.
const order = (cuts: Cuts | undefined) => Object.entries(cuts!).map(([id, cols]) => [id, ...Object.keys(cols)])
const BOUNDS = 'max_chars_per_cell must be an integer from 1 to 200000.'

async function main() {
  await check('a page: long cells cut to N, short ones as they are, truncated_cells by row then column', async () => {
    const r = await okRead({ max_chars_per_cell: 10 })
    assert.deepEqual(r.rows[0].data, { Name: 'Acme', Notes: 'n'.repeat(10), Json: JSON_TEXT.slice(0, 10),
      Ping: '✅ 200', Code: 'c'.repeat(10) })
    assert.equal(r.rows[1].data.Notes, `ab${'😀'.repeat(4)}`)
    assert.deepEqual(r.rows[2].data, { Name: 'Gamma', Notes: 'short' })
    assert.deepEqual(r.truncated_cells, { [r0]: { Notes: 300, Json: JSON_TEXT.length, Code: 50 }, [r1]: { Notes: 22 } })
    assert.deepEqual(order(r.truncated_cells), [[r0, 'Notes', 'Json', 'Code'], [r1, 'Notes']])
    assert.deepEqual(Object.keys(r), ['rows', 'truncated_cells', 'next_cursor', 'data_version', 'row_generation'])
    // An odd N would end on an emoji's first half: one fewer, never half of it.
    const odd = await okRead({ max_chars_per_cell: 11 })
    assert.equal(odd.rows[1].data.Notes, `ab${'😀'.repeat(4)}`)
    assert.equal((await okRead({ max_chars_per_cell: 1 })).rows[1].data.Notes, 'a')
  })

  await check('without max_chars_per_cell: no truncated_cells, the same answer and key order otherwise', async () => {
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
      assert.deepEqual(wide.truncated_cells, {}, JSON.stringify(body))
      const { truncated_cells: _, ...rest } = wide
      assert.deepEqual({ ...rest, as_of: undefined }, { ...plain, as_of: undefined }, JSON.stringify(body))
      assert.deepEqual(Object.keys(rest), Object.keys(plain), JSON.stringify(body))
      assert.deepEqual(rest.rows.map(row => Object.keys(row)), plain.rows.map(row => Object.keys(row)))
    }
  })

  await check('the bounds: 1 to 200000, digits as text the number; anything else refused on REST and MCP', async () => {
    const texts = ['1.5', '1e3', '0x10', '-3', '', '12a', '0', '200001']
    for (const bad of [0, -1, 200_001, 2.5, ...texts, null, true, [10]]) {
      assert.equal(await refusal({ max_chars_per_cell: bad }), BOUNDS, `REST ${JSON.stringify(bad)}`)
    }
    // Digits sent as text are the number on REST too: cut to 12, the same answer.
    const asText = await okRead({ max_chars_per_cell: '12' })
    assert.equal(asText.rows[0].data.Notes, 'n'.repeat(12))
    assert.deepEqual(asText, await okRead({ max_chars_per_cell: 12 }))
    // The query MCP builds is checked again with the same words (its schema refuses first).
    for (const bad of [0, 200_001, 2.5, Number.NaN]) {
      assert.equal(await refusal({}, { maxCharsPerCell: bad }), BOUNDS, `MCP ${bad}`)
      assert.equal(await refusal({ row_ids: [r0] }, { maxCharsPerCell: bad }), BOUNDS, `MCP by id ${bad}`)
    }
    assert.ok((await okRead({ max_chars_per_cell: 200_000 })).rows.length === 4)
  })

  await check('groups and counts return no cells: the first refusal names max_chars_per_cell', async () => {
    const groups = 'group_by and aggregates answer groups, not rows: leave out cursor, limit, columns, return_mode, '
      + 'include_status and max_chars_per_cell.'
    assert.equal(await refusal({ group_by: ['Name'], max_chars_per_cell: 10 }), groups)
    assert.equal(await refusal({ group_by: ['Name'], columns: ['Name'], max_chars_per_cell: 10 }), groups)
    assert.equal(await refusal({ aggregates: [{ op: 'count' }], max_chars_per_cell: 10 }), groups)
    // One round: leaving out what it names is enough.
    assert.ok((await okRead({ group_by: ['Name'] })).groups)
    const count = 'count mode does not accept cursor, limit, columns, or max_chars_per_cell'
    assert.equal(await refusal({ return_mode: 'count', max_chars_per_cell: 10 }), count)
    assert.equal(await refusal({ return_mode: 'count', columns: ['Name'], limit: 2, max_chars_per_cell: 10 }), count)
    assert.equal(await refusal({ return_mode: 'ids', max_chars_per_cell: 10 }),
      'max_chars_per_cell works with return_mode rows only')
    assert.equal(await refusal({ return_mode: 'ids', include_status: true, max_chars_per_cell: 10 }),
      'include_status and max_chars_per_cell work with return_mode rows only')
    // Without it the words are as they were.
    assert.equal(await refusal({ group_by: ['Name'], columns: ['Name'] }), 'group_by and aggregates answer groups, '
      + 'not rows: leave out cursor, limit, columns, return_mode and include_status.')
    assert.equal(await refusal({ return_mode: 'count', columns: ['Name'] }),
      'count mode does not accept cursor, limit, or columns')
    assert.equal(await refusal({ return_mode: 'ids', include_status: true }),
      'include_status works with return_mode rows only')
  })

  await check('a filtered read and its next page: each page lists its own cut cells', async () => {
    const where = [{ column: 'Notes', operator: 'not_empty' }]
    const first = await okRead({ where, limit: 1, max_chars_per_cell: 10 })
    assert.deepEqual(first.rows.map(r => r.id), [r0])
    assert.deepEqual(order(first.truncated_cells), [[r0, 'Notes', 'Json', 'Code']])
    const next = await okRead({ where, limit: 2, cursor: first.next_cursor, max_chars_per_cell: 10,
      expected_data_version: first.data_version, expected_row_generation: first.row_generation })
    assert.deepEqual(next.rows.map(r => r.id), [r1, r2])
    assert.deepEqual(next.truncated_cells, { [r1]: { Notes: 22 } })
  })

  await check('columns with JSON paths: text cut, an object cut as its JSON text, a number as it is', async () => {
    const r = await okRead({ max_chars_per_cell: 20, columns: ['Name', { column: 'Json', path: ['data', 'bio'],
      as: 'Bio' }, { column: 'Json', path: ['data'] }, { column: 'Json', path: ['data', 'n'], as: 'N' },
    { column: 'Json', path: ['data', 'emails', 0], as: 'Email' }] })
    const whole = JSON.stringify(DATA)
    assert.deepEqual(r.rows[0].data, { Name: 'Acme', Bio: 'b'.repeat(20), 'Json.data': whole.slice(0, 20), N: 12345,
      Email: 'a@acme.com' })
    assert.deepEqual(r.rows[1].data, { Name: 'Beta', Bio: null, 'Json.data': null, N: null, Email: null })
    assert.deepEqual(r.truncated_cells, { [r0]: { Bio: 300, 'Json.data': whole.length } })
    assert.deepEqual(order(r.truncated_cells), [[r0, 'Bio', 'Json.data']])
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
    assert.deepEqual(r.truncated_cells![r1], { Notes: 22, Ping: 6 })
    // A read by id says the run's whole error: that is what gets cut.
    const byId = await okRead({ row_ids: [r1], include_status: true, columns: ['Ping'], max_chars_per_cell: 20 })
    assert.deepEqual(byId.rows[0].data.Ping, { status: 'error', value: null, error: LONG_ERROR.slice(0, 20) })
    assert.deepEqual(byId.truncated_cells, { [r1]: { Ping: LONG_ERROR.length } })
    // A run column picked under another name is still a run cell.
    const named = await okRead({ include_status: true, columns: [{ column: 'Code', as: 'C' }], max_chars_per_cell: 5 })
    assert.deepEqual(named.rows[0].data.C, { status: 'done', value: 'ccccc', error: null })
    assert.deepEqual(named.truncated_cells, { [r0]: { C: 50 } })
  })

  await check('include_status: a path pick on a run column, and a column under a run column\'s name, are values',
    async () => {
      // Out is an HTTP API column holding JSON; Plain and Meta are typed columns.
      const META = { status: 'kept', value: 'v'.repeat(40) }
      const R = sheet(['Ask', 'Out', 'Plain', 'Meta'], [{ Ask: '✅ 200',
        Out: JSON.stringify({ summary: 's'.repeat(40), meta: META }), Plain: 'p'.repeat(40),
        Meta: JSON.stringify({ meta: META }) }])
      const run = uuid()
      db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
        VALUES (?,?,?,?, 'completed', 'Ask')`)
        .run(run, R.sid, uid, JSON.stringify({ responseMapping: [{ columnName: 'Out', jsonPath: '$' }] }))
      db.prepare(`INSERT INTO http_column_associations
        (id,sheet_id,user_id,master_column_name,extracted_column_name,run_id) VALUES (?,?,?,'Ask','Out',?)`)
        .run(uuid(), R.sid, uid, run)
      const columns = [{ column: 'Out', path: ['summary'], as: 'Sum' }, { column: 'Out', path: ['meta'], as: 'M' },
        { column: 'Plain', as: 'Ask' }, { column: 'Meta', path: ['meta'], as: 'Out' }]
      const r = await okRead({ include_status: true, columns, max_chars_per_cell: 10 }, {}, R.sid)
      // Each cut as text: an object as its JSON text, never as a {status, value} with its value cut.
      const meta = JSON.stringify(META)
      assert.deepEqual(r.rows[0].data, { Sum: 's'.repeat(10), M: meta.slice(0, 10), Ask: 'p'.repeat(10),
        Out: meta.slice(0, 10) })
      assert.deepEqual(r.truncated_cells, { [R.ids[0]]: { Sum: 40, M: meta.length, Ask: 40, Out: meta.length } })
      // Read whole, Ask and Out still hold the values picked, not run cells.
      const whole = await okRead({ include_status: true, columns }, {}, R.sid)
      assert.deepEqual(whole.rows[0].data, { Sum: 's'.repeat(40), M: META, Ask: 'p'.repeat(40), Out: META })
    })

  await check('row_ids: the order asked; over MCP each row counts with its entry, one row always back', async () => {
    const r = await okRead({ row_ids: [r1, r0], columns: ['Notes'], max_chars_per_cell: 10 })
    assert.deepEqual(r.truncated_cells, { [r1]: { Notes: 22 }, [r0]: { Notes: 300 } })
    assert.deepEqual(order(r.truncated_cells), [[r1, 'Notes'], [r0, 'Notes']])
    assert.deepEqual(Object.keys(r), ['rows', 'truncated_cells', 'missing', 'data_version', 'row_generation'])
    const W = sheet(['Answer'], Array.from({ length: 30 }, (_, i) => ({ Answer: `${i}`.padEnd(3000, 'x') })))
    const whole = await okRead({ row_ids: W.ids }, { maxChars: 40_000 }, W.sid)
    assert.ok(whole.rows.length < 15 && (whole.unread_ids as string[]).length > 15, `${whole.rows.length} rows`)
    const cut = await okRead({ row_ids: W.ids, max_chars_per_cell: 100 }, { maxChars: 40_000 }, W.sid)
    assert.equal(cut.rows.length, 30)
    assert.equal(cut.unread_ids, undefined)
    assert.deepEqual(Object.keys(cut.truncated_cells!), W.ids)
    // The cap counts each row's truncated_cells entry, and keeps only the entries of the rows returned.
    const tight = await okRead({ row_ids: W.ids, max_chars_per_cell: 100 }, { maxChars: 1_000 }, W.sid)
    assert.ok(tight.rows.length > 1 && tight.rows.length < 10, `${tight.rows.length} rows`)
    assert.ok(JSON.stringify({ rows: tight.rows, truncated_cells: tight.truncated_cells }).length <= 1_000)
    assert.deepEqual(Object.keys(tight.truncated_cells!), tight.rows.map(row => row.id))
    assert.deepEqual(tight.unread_ids, W.ids.slice(tight.rows.length))
    // One row whose cut text and entry alone pass the cap still comes back, with its entry only.
    const one = await okRead({ row_ids: W.ids, max_chars_per_cell: 100 }, { maxChars: 10 }, W.sid)
    assert.deepEqual(one.rows.map(row => row.id), [W.ids[0]])
    assert.deepEqual(one.truncated_cells, { [W.ids[0]]: { Answer: 3000 } })
    assert.deepEqual(one.unread_ids, W.ids.slice(1))
  })

  await check('updated_since: the cells as rows hold them, cut', async () => {
    const r = await okRead({ updated_since: '2000-01-01T00:00:00Z', columns: ['Notes'], max_chars_per_cell: 4 })
    assert.deepEqual(r.rows.map(row => row.data.Notes), ['nnnn', 'ab😀', 'shor', ''])
    assert.deepEqual(r.truncated_cells, { [r0]: { Notes: 300 }, [r1]: { Notes: 22 }, [r2]: { Notes: 5 } })
    assert.deepEqual(Object.keys(r.truncated_cells!), r.rows.slice(0, 3).map(row => row.id))
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
    assert.deepEqual(r.truncated_cells, { [r0]: { Notes: 300 }, [r1]: { Notes: 22 } })
    assert.equal(typeof r.view_version, 'string')
  })

  if (failures) { console.error(`${failures} read-max-chars check(s) failed`); process.exit(1) }
  console.log('All read-max-chars assertions passed.')
}

main().catch(e => { console.error(e); process.exit(1) })

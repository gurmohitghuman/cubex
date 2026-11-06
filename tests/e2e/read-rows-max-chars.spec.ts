import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { BAD_URL, pollTerminal } from './helpers-run-results'

// read_rows (MCP) and POST /api/v1/sheets/:id/rows/query (REST) with
// max_chars_per_cell: each long cell cut to its first N characters (an emoji
// never split), short ones as they are, and truncated_cells listing the cells
// cut as {row_id, column, full_length}; without it, no truncated_cells and the
// whole cells. Bounds, groups and counts refused with the same words on both.
// It holds through columns with JSON paths, a view, row_ids, updated_since and
// include_status (a run cell's value or error cut, never its status).

const bearer = (token: string) => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` },
})
type Row = { id: string; index: number; data: Record<string, any> }
type Cut = { row_id: string; column: string; full_length: number }
const DATA = { bio: 'b'.repeat(300), n: 12345 }
const JSON_TEXT = JSON.stringify({ data: DATA })
const EMOJI = `ab${'😀'.repeat(10)}` // 22 UTF-16 code units
const BOUNDS = 'max_chars_per_cell must be an integer from 1 to 200000.'
// No half of a surrogate pair anywhere in the text.
const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)

// A sheet: val (v0..v2), Notes (long, an emoji row, short) and Json (a JSON cell on row 0).
async function longCells() {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  for (const columnName of ['Notes', 'Json']) {
    expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName } })).ok()).toBeTruthy()
  }
  const rw = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'max chars rw'))
  const ids: string[] = (await call(rw, 'read_rows', { sheet_id: sheetId })).rows.map((r: Row) => r.id)
  await call(rw, 'update_cells', { sheet_id: sheetId, updates: [
    { row_id: ids[0], data: { Notes: 'n'.repeat(500), Json: JSON_TEXT } },
    { row_id: ids[1], data: { Notes: EMOJI } }, { row_id: ids[2], data: { Notes: 'short' } },
  ] })
  const ro = await mcpClient(await makeAccessToken(api, ['read'], 'max chars read only'))
  const rest = await bearer(await makeAccessToken(api, ['read'], 'max chars rest read only'))
  const query = async (body: Record<string, unknown>) => {
    const res = await rest.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: body })
    return { status: res.status(), body: await res.json() }
  }
  return { api, sheetId, ids, rw, ro, query }
}

test('max_chars_per_cell: cut cells listed, short ones as they are, no option unchanged, refusals', async () => {
  test.setTimeout(90_000)
  const { sheetId, ids, ro, query } = await longCells()

  // 11 would end on an emoji's first half: that row keeps 10.
  const mcp = await call(ro, 'read_rows', { sheet_id: sheetId, max_chars_per_cell: 11 })
  expect(mcp.rows.map((r: Row) => r.data)).toEqual([
    { val: 'v0', Notes: 'n'.repeat(11), Json: JSON_TEXT.slice(0, 11) },
    { val: 'v1', Notes: `ab${'😀'.repeat(4)}` },
    { val: 'v2', Notes: 'short' },
  ])
  expect(wellFormed(mcp.rows[1].data.Notes)).toBe(true)
  const expected: Cut[] = [
    { row_id: ids[0], column: 'Notes', full_length: 500 },
    { row_id: ids[0], column: 'Json', full_length: JSON_TEXT.length },
    { row_id: ids[1], column: 'Notes', full_length: 22 },
  ]
  expect(mcp.truncated_cells).toEqual(expected)
  // REST: the same answer. Digits sent as text over MCP are the number.
  const rest = await query({ max_chars_per_cell: 11 })
  expect(rest.status).toBe(200)
  expect(rest.body.rows).toEqual(mcp.rows)
  expect(rest.body.truncated_cells).toEqual(expected)
  expect((await call(ro, 'read_rows', { sheet_id: sheetId, max_chars_per_cell: '11' })).truncated_cells)
    .toEqual(expected)
  // Nothing long enough: truncated_cells is there, empty.
  expect((await call(ro, 'read_rows', { sheet_id: sheetId, max_chars_per_cell: 200_000 })).truncated_cells)
    .toEqual([])

  // Without it: whole cells and no truncated_cells, on both surfaces.
  const plain = await call(ro, 'read_rows', { sheet_id: sheetId })
  expect(plain).not.toHaveProperty('truncated_cells')
  expect(plain.rows[0].data).toEqual({ val: 'v0', Notes: 'n'.repeat(500), Json: JSON_TEXT })
  const restPlain = await query({})
  expect(restPlain.body).not.toHaveProperty('truncated_cells')
  expect(restPlain.body.rows).toEqual(plain.rows)

  // Refusals: the exact words, a 400 on REST.
  for (const bad of [0, 200_001, 2.5]) {
    expect(await callError(ro, 'read_rows', { sheet_id: sheetId, max_chars_per_cell: bad })).toBe(BOUNDS)
    expect(await query({ max_chars_per_cell: bad })).toEqual({ status: 400, body: { error: BOUNDS } })
  }
  expect(await query({ max_chars_per_cell: '11' })).toEqual({ status: 400, body: { error: BOUNDS } })
  const groups = 'group_by and aggregates answer groups, not rows: leave out max_chars_per_cell.'
  expect(await callError(ro, 'read_rows', { sheet_id: sheetId, group_by: ['val'], max_chars_per_cell: 10 }))
    .toBe(groups)
  expect(await query({ group_by: ['val'], max_chars_per_cell: 10 })).toEqual({ status: 400, body: { error: groups } })
  const rowsOnly = 'max_chars_per_cell works with return_mode rows only'
  expect(await callError(ro, 'read_rows', { sheet_id: sheetId, return_mode: 'count', max_chars_per_cell: 10 }))
    .toBe(rowsOnly)
  expect(await query({ return_mode: 'ids', max_chars_per_cell: 10 }))
    .toEqual({ status: 400, body: { error: rowsOnly } })
})

test('max_chars_per_cell with JSON paths, a view, row_ids and updated_since', async () => {
  test.setTimeout(90_000)
  const { sheetId, ids, rw, ro, query } = await longCells()

  // JSON paths: text cut, an object cut as its JSON text (under the name it comes back as), a number whole.
  const columns = ['val', { column: 'Json', path: ['data', 'bio'], as: 'Bio' }, { column: 'Json', path: ['data'] },
    { column: 'Json', path: ['data', 'n'], as: 'N' }]
  const picked = await call(ro, 'read_rows', { sheet_id: sheetId, columns, max_chars_per_cell: 20 })
  const whole = JSON.stringify(DATA)
  expect(picked.rows[0].data).toEqual({ val: 'v0', Bio: 'b'.repeat(20), 'Json.data': whole.slice(0, 20), N: 12345 })
  expect(picked.truncated_cells).toEqual([{ row_id: ids[0], column: 'Bio', full_length: 300 },
    { row_id: ids[0], column: 'Json.data', full_length: whole.length }])
  const restPicked = await query({ columns, max_chars_per_cell: 20 })
  expect([restPicked.body.rows, restPicked.body.truncated_cells]).toEqual([picked.rows, picked.truncated_cells])

  // A view: its filter, its visible columns only, view_version as usual.
  await call(rw, 'manage_view', { sheet_id: sheetId, action: 'create', name: 'Long notes',
    where: [{ column: 'val', operator: 'neq', value: 'v1' }], hidden_columns: ['Json'] })
  const viewed = await call(ro, 'read_rows', { sheet_id: sheetId, view: 'Long notes', max_chars_per_cell: 5 })
  expect(viewed.rows.map((r: Row) => r.data)).toEqual([{ val: 'v0', Notes: 'nnnnn' }, { val: 'v2', Notes: 'short' }])
  expect(viewed.truncated_cells).toEqual([{ row_id: ids[0], column: 'Notes', full_length: 500 }])
  expect(typeof viewed.view_version).toBe('string')

  // row_ids: the order asked, the entries in that order.
  const byId = { row_ids: [ids[1], ids[0]], columns: ['Notes'], max_chars_per_cell: 10 }
  const mcpById = await call(ro, 'read_rows', { sheet_id: sheetId, ...byId })
  expect(mcpById.rows.map((r: Row) => r.data.Notes)).toEqual([`ab${'😀'.repeat(4)}`, 'n'.repeat(10)])
  expect(mcpById.truncated_cells).toEqual([{ row_id: ids[1], column: 'Notes', full_length: 22 },
    { row_id: ids[0], column: 'Notes', full_length: 500 }])
  expect(mcpById.missing).toEqual([])
  const restById = await query(byId)
  expect([restById.body.rows, restById.body.truncated_cells]).toEqual([mcpById.rows, mcpById.truncated_cells])

  // updated_since: the cells as rows hold them, cut, and the walk's own fields.
  const since = { updated_since: '2000-01-01T00:00:00Z', columns: ['Notes'], max_chars_per_cell: 10 }
  const mcpSince = await call(ro, 'read_rows', { sheet_id: sheetId, ...since })
  expect(new Set(mcpSince.truncated_cells.map((c: Cut) => `${c.row_id}:${c.full_length}`)))
    .toEqual(new Set([`${ids[0]}:500`, `${ids[1]}:22`]))
  expect(mcpSince.rows.find((r: Row) => r.id === ids[2]).data).toEqual({ Notes: 'short' })
  expect(mcpSince).toHaveProperty('as_of')
  expect(mcpSince.filling).toEqual([])
  const restSince = await query(since)
  expect(restSince.body.truncated_cells).toEqual(mcpSince.truncated_cells)
})

test('max_chars_per_cell with include_status: a run cell\'s value or error cut, never its status', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'max chars run'))
  const ids: string[] = (await call(client, 'read_rows', { sheet_id: sheetId })).rows.map((r: Row) => r.id)
  // Every row's request answers 404; then row 0's Title is typed in by hand (done, 40 characters).
  const started = await call(client, 'run_http_enrichment', {
    sheet_id: sheetId, url: BAD_URL, method: 'GET',
    response_mapping: [{ json_path: '$.title', column_name: 'Title' }], master_column_name: 'Lookup',
  })
  expect((await pollTerminal(client, started.run_id)).status).toBe('completed')
  await call(client, 'update_cells', { row_id: ids[0], data: { Title: 't'.repeat(40) } })

  const columns = ['val', 'Lookup', 'Title']
  const page = await call(client, 'read_rows', { sheet_id: sheetId, include_status: true, columns,
    max_chars_per_cell: 5 })
  expect(page.rows[0].data).toEqual({ val: 'v0', Lookup: { status: 'error', value: null, error: 'Faile' },
    Title: { status: 'done', value: 'ttttt', error: null } })
  expect(page.rows[1].data.Lookup).toEqual({ status: 'error', value: null, error: 'Faile' })
  // Every cell: as read whole, its text cut to 5 and listed when longer, its status the same.
  const whole = await call(client, 'read_rows', { sheet_id: sheetId, include_status: true, columns })
  const listed: Cut[] = []
  whole.rows.forEach((row: Row, i: number) => {
    for (const c of ['Lookup', 'Title']) {
      const full = row.data[c], got = page.rows[i].data[c]
      expect(got.status).toBe(full.status)
      const text: string = full.value ?? full.error ?? ''
      expect(got.value ?? got.error ?? '').toBe(text.slice(0, 5))
      if (text.length > 5) listed.push({ row_id: row.id, column: c, full_length: text.length })
    }
  })
  expect(page.truncated_cells).toEqual(listed)

  // By id: the run's whole error is what gets cut, on both surfaces.
  const full = (await call(client, 'read_rows', { sheet_id: sheetId, row_ids: [ids[1]], include_status: true,
    columns: ['Lookup'] })).rows[0].data.Lookup.error as string
  expect(full).toMatch(/404/)
  expect(full.length).toBeGreaterThan(12)
  const cut = await call(client, 'read_rows', { sheet_id: sheetId, row_ids: [ids[1]], include_status: true,
    columns: ['Lookup'], max_chars_per_cell: 12 })
  expect(cut.rows[0].data.Lookup).toEqual({ status: 'error', value: null, error: full.slice(0, 12) })
  expect(cut.truncated_cells).toEqual([{ row_id: ids[1], column: 'Lookup', full_length: full.length }])
  const rest = await bearer(await makeAccessToken(api, ['read'], 'max chars run rest'))
  const res = await rest.post(`/api/v1/sheets/${sheetId}/rows/query`,
    { data: { row_ids: [ids[1]], include_status: true, columns: ['Lookup'], max_chars_per_cell: 12 } })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect([body.rows, body.truncated_cells]).toEqual([cut.rows, cut.truncated_cells])
})

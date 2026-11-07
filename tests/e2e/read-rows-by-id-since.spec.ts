import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { BAD_URL, pollTerminal } from './helpers-run-results'

// read_rows (MCP) and POST /api/v1/sheets/:id/rows/query (REST): rows by id and
// rows changed since a time. By id: the rows in the order asked, `missing` for
// a deleted id, a failed run cell's full error with include_status (a page
// read says what the cell holds). By time: the edits and new rows since the
// last read's as_of, a deleted row not among them (the copy drops it by listing
// ids), paging with the text cursor. Both work with a read-only token and
// refuse what they don't take. A row index quoted as text over MCP still pages.

const bearer = (token: string) => pwRequest.newContext({
  baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` },
})
type Row = { id: string; index: number; updated_at?: string; data: Record<string, any> }

test('rows by id: order, missing (a deleted row too), and the full error text', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 4)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'by-id rw'))
  const ids: string[] = (await call(client, 'read_rows', { sheet_id: sheetId })).rows.map((r: Row) => r.id)

  // Every row's request answers 404: the cells say only "❌ Failed" / "❌ Error".
  const started = await call(client, 'run_http_enrichment', {
    sheet_id: sheetId, url: BAD_URL, method: 'GET',
    response_mapping: [{ json_path: '$.title', column_name: 'Title' }], master_column_name: 'Lookup',
  })
  expect((await pollTerminal(client, started.run_id)).status).toBe('completed')
  const rw = await bearer(await makeAccessToken(api, ['read', 'write'], 'by-id rest'))
  expect((await rw.post(`/api/v1/sheets/${sheetId}/rows/delete`, { data: { row_ids: [ids[3]] } })).ok()).toBeTruthy()

  const ro = await mcpClient(await makeAccessToken(api, ['read'], 'by-id read only'))
  const asked = [ids[2], ids[0], ids[3], 'not-a-row']
  const byId = await call(ro, 'read_rows', { sheet_id: sheetId, row_ids: asked, include_status: true })
  expect(byId.rows.map((r: Row) => r.id)).toEqual([ids[2], ids[0]])
  expect(byId.rows.map((r: Row) => r.data.val)).toEqual(['v2', 'v0'])
  expect(byId.missing).toEqual([ids[3], 'not-a-row'])
  expect(byId.rows[0].updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  const lookup = byId.rows[0].data.Lookup, title = byId.rows[0].data.Title
  expect(lookup.status).toBe('error')
  expect(lookup.error).toMatch(/404/)
  expect(title).toMatchObject({ status: 'error', error: lookup.error })
  // A page read keeps the cell's own words.
  const page = await call(ro, 'read_rows', { sheet_id: sheetId, include_status: true, limit: 1 })
  expect(page.rows[0].data.Lookup).toMatchObject({ status: 'error', error: 'Failed' })

  // REST, read-only token: the same answer, and columns.
  const rest = await bearer(await makeAccessToken(api, ['read'], 'by-id rest read only'))
  const res = await rest.post(`/api/v1/sheets/${sheetId}/rows/query`,
    { data: { row_ids: asked, include_status: true, columns: ['val', 'Lookup'] } })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.missing).toEqual([ids[3], 'not-a-row'])
  expect(body.rows[1].data).toEqual({ val: 'v0', Lookup: { status: 'error', value: null, error: lookup.error } })

  // Refusals: what a read by id doesn't take.
  expect(await callError(ro, 'read_rows', { sheet_id: sheetId, row_ids: [ids[0]],
    where: [{ column: 'val', operator: 'not_empty' }] })).toMatch(/leave out where/)
  expect(await callError(ro, 'read_rows', { sheet_id: sheetId, row_ids: [ids[0], ids[0]] })).toMatch(/twice/)
  const refused = await rest.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { row_ids: [ids[0]], cursor: 1 } })
  expect(refused.status()).toBe(400)
  expect((await refused.json()).error).toMatch(/leave out cursor/)
  const tooMany = await rest.post(`/api/v1/sheets/${sheetId}/rows/query`,
    { data: { row_ids: Array.from({ length: 1001 }, (_, i) => `r${i}`) } })
  expect(tooMany.status()).toBe(400)
})

test('rows changed since: a copy kept up to date with the as_of loop, over MCP and REST', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 5)
  const ro = await mcpClient(await makeAccessToken(api, ['read'], 'since read only'))
  const rest = await bearer(await makeAccessToken(api, ['read'], 'since rest read only'))
  const rw = await bearer(await makeAccessToken(api, ['read', 'write'], 'since rest rw'))

  // A walk over MCP, two rows a page; and one over REST.
  async function walkMcp(since: string) {
    const rows: Row[] = []
    let cursor: string | undefined, asOf = ''
    do {
      const r = await call(ro, 'read_rows', { sheet_id: sheetId, updated_since: since, limit: 2,
        ...(cursor ? { cursor } : {}) })
      rows.push(...r.rows)
      asOf ||= r.as_of
      expect(r.as_of).toBe(asOf)
      expect(r.filling).toEqual([])
      cursor = r.next_cursor ?? undefined
    } while (cursor)
    return { rows, asOf }
  }
  async function walkRest(since: string) {
    const rows: Row[] = []
    let cursor: string | undefined, asOf = ''
    do {
      const res = await rest.post(`/api/v1/sheets/${sheetId}/rows/query`,
        { data: { updated_since: since, limit: 2, ...(cursor ? { cursor } : {}) } })
      expect(res.status()).toBe(200)
      const r = await res.json()
      rows.push(...r.rows)
      asOf ||= r.as_of
      cursor = r.next_cursor ?? undefined
    } while (cursor)
    return { rows, asOf }
  }

  const copy = new Map<string, Record<string, any>>()
  const first = await walkMcp('2000-01-01T00:00:00Z')
  for (const r of first.rows) copy.set(r.id, r.data)
  expect(copy.size).toBe(5)
  expect(first.asOf).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  const restFirst = await walkRest('2000-01-01 00:00:00')
  expect(new Set(restFirst.rows.map(r => r.id))).toEqual(new Set(copy.keys()))
  // A model quoting a page read's cursor: digits as text are the row index.
  const quoted = await call(ro, 'read_rows', { sheet_id: sheetId, cursor: '1', limit: 2 })
  expect(quoted.rows.map((r: Row) => r.index)).toEqual([2, 3])

  // Changes after the first read: an edit, a new row, a deleted row.
  const ids = [...copy.keys()]
  expect((await rw.patch(`/api/v1/rows/${ids[1]}`, { data: { data: { val: 'edited' } } })).ok()).toBeTruthy()
  expect((await rw.post(`/api/v1/sheets/${sheetId}/rows`, { data: { rows: [{ data: { val: 'new' } }] } })).ok())
    .toBeTruthy()
  expect((await rw.post(`/api/v1/sheets/${sheetId}/rows/delete`, { data: { row_ids: [ids[4]] } })).ok()).toBeTruthy()

  for (const next of [await walkMcp(first.asOf), await walkRest(first.asOf)]) {
    const seen = new Map(next.rows.map(r => [r.id, r]))
    expect(seen.get(ids[1])?.data.val).toBe('edited')
    expect([...seen.values()].some(r => r.data.val === 'new')).toBe(true)
    expect(seen.has(ids[4])).toBe(false)
  }
  // Dedupe by id, then drop the rows gone (ids listed with return_mode ids): the copy matches the sheet.
  for (const r of (await walkMcp(first.asOf)).rows) copy.set(r.id, r.data)
  const live = await call(ro, 'read_rows', { sheet_id: sheetId, return_mode: 'ids' })
  const liveIds = new Set(live.rows.map((r: Row) => r.id))
  for (const id of [...copy.keys()]) if (!liveIds.has(id)) copy.delete(id)
  expect(copy.has(ids[4])).toBe(false)
  const now = await call(ro, 'read_rows', { sheet_id: sheetId })
  expect(Object.fromEntries(copy)).toEqual(Object.fromEntries(now.rows.map((r: Row) => [r.id, r.data])))

  // Refusals.
  expect(await callError(ro, 'read_rows', { sheet_id: sheetId, updated_since: 'yesterday' }))
    .toMatch(/updated_since must be/)
  expect(await callError(ro, 'read_rows', { sheet_id: sheetId, updated_since: first.asOf, cursor: 3 }))
    .toMatch(/a number cursor/)
  expect(await callError(ro, 'read_rows', { sheet_id: sheetId, updated_since: first.asOf, view: 'Default' }))
    .toMatch(/leave out view/)
  const bad = await rest.post(`/api/v1/sheets/${sheetId}/rows/query`,
    { data: { updated_since: first.asOf, where: [{ column: 'val', operator: 'not_empty' }] } })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toMatch(/leave out where/)
})

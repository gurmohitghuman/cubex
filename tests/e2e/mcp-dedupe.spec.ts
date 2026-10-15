import { test, expect } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, getSheet, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { bearer } from './api-v1-run-helpers'
import { EMAILS_LEFT, LEADS, seedLeads } from './helpers-dedupe'

// remove_duplicates (MCP) and POST /api/v1/sheets/:id/remove-duplicates: a dry
// run unless dry_run is false, readable with the read scope; the removal needs
// write, keeps the first row of each group and rows with nothing to match on,
// moves row_generation (a stale tab's delete is refused) and finds nothing the
// second time.

const rowsOf = async (client: Client, sheetId: string) =>
  (await call(client, 'read_rows', { sheet_id: sheetId })).rows as Array<{ id: string; data: Record<string, string> }>
const BY_EMAIL = [{ column: 'Email', match: 'email' }]

test('remove_duplicates: dry run by default, scopes, removal, stale tabs', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedLeads(api)
  const rw = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e dedupe'), 'e2e-dedupe')
  const ro = await mcpClient(await makeAccessToken(api, ['read'], 'e2e dedupe read'), 'e2e-dedupe-read')

  const tool = (await rw.listTools()).tools.find(t => t.name === 'remove_duplicates')
  expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  expect(tool?.description).toContain('PERMANENTLY')

  const dry = await call(ro, 'remove_duplicates', { sheet_id: sheetId, columns: BY_EMAIL })
  expect(dry).toMatchObject({
    dry_run: true, rows_checked: LEADS.length, rows_to_remove: 3, duplicate_groups: 2, rows_with_empty_key: 4,
    rows_left: 6, keep: 'first',
  })
  expect(dry.note).toContain('dry_run: false')
  expect(dry.samples[0].kept).toMatchObject({ row: 1, values: { Email: 'jo@acme.com' } })
  expect(dry.samples[0].removed.map((r: any) => r.row)).toEqual([2, 6])
  expect(dry.samples[0].group_size).toBe(3)
  expect((await rowsOf(rw, sheetId)).length).toBe(LEADS.length)

  const byDomain = await call(rw, 'remove_duplicates',
    { sheet_id: sheetId, columns: [{ column: 'Website', match: 'domain' }] })
  expect(byDomain).toMatchObject({ rows_to_remove: 2, duplicate_groups: 2 })
  const last = await call(rw, 'remove_duplicates', { sheet_id: sheetId, columns: BY_EMAIL, keep: 'last' })
  expect(last.samples[0].kept.row).toBe(6)

  expect(await callError(ro, 'remove_duplicates', { sheet_id: sheetId, columns: BY_EMAIL, dry_run: false }))
    .toContain("'write' scope")
  expect(await callError(rw, 'remove_duplicates', { sheet_id: sheetId, columns: ['Nope'] }))
    .toContain('no column named "Nope"')

  const gen = (await getSheet(api, sheetId)).sheet.row_generation ?? 0
  const removed = await call(rw, 'remove_duplicates', { sheet_id: sheetId, columns: BY_EMAIL, dry_run: false })
  expect(removed).toMatchObject({ dry_run: false, rows_removed: 3, rows_left: 6 })
  expect((await rowsOf(rw, sheetId)).map(r => r.data.Email ?? '')).toEqual(EMAILS_LEFT)
  const stale = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`,
    { data: { rowIndices: [0], rowGeneration: gen } })
  expect(stale.status()).toBe(409)
  const again = await call(rw, 'remove_duplicates', { sheet_id: sheetId, columns: BY_EMAIL, dry_run: false })
  expect(again.rows_removed).toBe(0)
})

test('POST /api/v1/sheets/:id/remove-duplicates: same answer, read scope for a dry run only', async () => {
  const api = await authedApi()
  const { sheetId } = await seedLeads(api)
  const ro = await bearer(await makeAccessToken(api, ['read'], 'e2e dedupe v1 read'))
  const rw = await bearer(await makeAccessToken(api, ['read', 'write'], 'e2e dedupe v1'))
  const url = `/api/v1/sheets/${sheetId}/remove-duplicates`

  const dry = await ro.post(url, { data: { columns: BY_EMAIL } })
  expect(dry.status()).toBe(200)
  expect(await dry.json()).toMatchObject({ dry_run: true, rows_to_remove: 3 })
  expect((await ro.post(url, { data: { columns: BY_EMAIL, dry_run: false } })).status()).toBe(403)
  const bad = await rw.post(url, { data: { columns: BY_EMAIL, keep: 'newest' } })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toContain('keep must be one of')
  expect((await rw.post(url, { data: { column: 'Email' } })).status()).toBe(400)

  const done = await rw.post(url, { data: { columns: BY_EMAIL, dry_run: false } })
  expect(done.status()).toBe(200)
  expect(await done.json()).toMatchObject({ dry_run: false, rows_removed: 3, rows_left: 6 })
  expect((await getSheet(api, sheetId)).data.rows.length).toBe(6)
})

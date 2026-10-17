import { test, expect } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { seedLookupSheets } from './helpers-lookup'

// lookup_column (MCP) and POST /api/v1/sheets/:id/lookup-columns: a column
// filled for free from another sheet. Preview writes nothing; each kind of
// answer; contains; get_sheet lists it; auto-run follows the source column;
// renaming the other sheet's columns rewrites it, deleting one stops it with
// a message; refusals.

const rowsOf = async (client: Client, sheetId: string) =>
  (await call(client, 'read_rows', { sheet_id: sheetId })).rows as Array<{ id: string; data: Record<string, string> }>
const col = async (client: Client, sheetId: string, column: string) =>
  (await rowsOf(client, sheetId)).map(r => r.data[column] ?? '')

test('lookup_column: preview, answers, contains, follow, renames, deletes, refusals', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const s = await seedLookupSheets(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e lookup'), 'e2e-lookup')
  expect((await client.listTools()).tools.map(t => t.name)).toContain('lookup_column')
  const base = { sheet_id: s.leadsId, other_sheet_id: s.companiesId, source_column: 'Domain', match_column: 'Website' }

  const preview = await call(client, 'lookup_column',
    { ...base, returns: 'value', return_column: 'Industry', preview: true })
  expect(preview.samples.map((x: any) => x.result)).toEqual(['Robots', 'Energy', ''])
  expect(preview.other_sheet).toBe('Companies')
  expect((await call(client, 'get_sheet', { sheet_id: s.leadsId })).columns).not.toContain('Industry')

  const industry = await call(client, 'lookup_column',
    { ...base, column: 'Industry', returns: 'value', return_column: 'Industry' })
  expect(industry).toMatchObject({ column: 'Industry', created: true, status: 'done', filled_rows: 2, auto_run: true,
    match: 'equals', returns: 'value', return_column: 'Industry', other_sheet: 'Companies' })
  expect(await col(client, s.leadsId, 'Industry')).toEqual(['Robots', 'Energy', ''])
  await call(client, 'lookup_column', { ...base, column: 'Known', returns: 'exists' })
  await call(client, 'lookup_column', { ...base, column: 'How many', returns: 'count' })
  expect(await col(client, s.leadsId, 'Known')).toEqual(['Yes', 'Yes', 'No'])
  expect(await col(client, s.leadsId, 'How many')).toEqual(['2', '1', '0'])
  await call(client, 'lookup_column',
    { ...base, column: 'Firms', returns: 'list', return_columns: ['Firm'], limit: 5 })
  expect(JSON.parse((await col(client, s.leadsId, 'Firms'))[0]))
    .toEqual([{ Firm: 'Acme Corporation' }, { Firm: 'Acme Labs' }])

  const contains = await call(client, 'lookup_column', { sheet_id: s.leadsId, other_sheet_id: s.companiesId,
    column: 'Has firm', source_column: 'Company', match_column: 'Firm', match: 'contains', returns: 'exists' })
  expect(contains).toMatchObject({ status: 'done', error_rows: 1 })
  expect(await col(client, s.leadsId, 'Has firm')).toEqual(['Yes', 'Yes', '❌ Contains needs at least 3 characters'])

  const meta = await call(client, 'get_sheet', { sheet_id: s.leadsId })
  expect(meta.lookup_columns.map((c: any) => c.column)).toEqual(['Industry', 'Known', 'How many', 'Firms', 'Has firm'])

  // Auto-run follows the source column.
  const rows = await rowsOf(client, s.leadsId)
  await call(client, 'update_cells', { row_id: rows[2].id, data: { Domain: 'Initech.com' } })
  await expect.poll(async () => (await col(client, s.leadsId, 'Industry'))[2], { timeout: 10_000 }).toBe('Software')

  // Renaming the other sheet's columns rewrites the lookup; deleting one it reads stops it.
  await call(client, 'rename_column', { sheet_id: s.companiesId, column: 'Industry', new_name: 'Sector' })
  const renamed = (await call(client, 'get_sheet', { sheet_id: s.leadsId })).lookup_columns
    .find((c: any) => c.column === 'Industry')
  expect(renamed.return_column).toBe('Sector')
  await call(client, 'delete_column', { sheet_id: s.companiesId, column: 'Firm' })
  const stopped = (await call(client, 'get_sheet', { sheet_id: s.leadsId })).lookup_columns
    .find((c: any) => c.column === 'Has firm')
  expect(stopped.broken).toMatch(/"Firm" in "Companies" was deleted/)

  // Refusals.
  expect(await callError(client, 'lookup_column', { ...base, other_sheet_id: s.leadsId, column: 'X',
    match_column: 'Name', returns: 'exists' })).toMatch(/different sheet/)
  expect(await callError(client, 'lookup_column', { ...base, column: 'X', returns: 'value',
    return_column: 'Nope' })).toMatch(/returnColumn|column of "Companies"/)
  expect(await callError(client, 'lookup_column', { ...base, column: 'Name', returns: 'exists' }))
    .toMatch(/already a column/)

  // REST: the same service, 201 for a new column.
  const token = await makeAccessToken(api, ['read', 'write'], 'e2e lookup rest')
  const res = await fetch(`${BASE}/api/v1/sheets/${s.leadsId}/lookup-columns`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, sheet_id: undefined, column: 'Rest known', returns: 'exists' }),
  })
  expect(res.status).toBe(201)
  expect(await res.json()).toMatchObject({ column: 'Rest known', created: true, status: 'done' })
  await client.close()
})

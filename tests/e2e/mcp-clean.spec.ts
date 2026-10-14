import { test, expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// clean_column (MCP) and POST /api/v1/sheets/:id/clean-columns: free cleaning
// into a new column. Preview writes nothing; a call waits for the fill and
// returns its counts; calling again on a clean column changes it; any other
// existing column, the source itself and a loop are refused; auto-run follows
// the source (edits and new rows), a hand edit stays until the source changes;
// rename and delete keep the record in step.

const SEED = [
  {
    Name: 'SMITH, JOHN', Email: '  John.Smith@Acme.COM ', Website: 'https://www.Acme.com/about',
    Phone: '212.555.0123',
  },
  { Name: 'jane doe', Email: 'not an email', Website: 'blog.acme.co.uk', Phone: '123' },
  { Name: 'Dr. Mary O\'Brien', Email: 'pat@acme.co.uk', Website: '', Phone: '+44 20 7946 0958' },
]

async function seedPeople(api: APIRequestContext): Promise<string> {
  const { sheetId } = await seedSheet(api, SEED.length)
  for (const c of ['Name', 'Email', 'Website', 'Phone']) {
    expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: c } })).ok()).toBeTruthy()
  }
  const updates = SEED.flatMap((r, i) =>
    Object.entries(r).map(([columnName, value]) => ({ rowIndex: i, columnName, value })))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  return sheetId
}

const rowsOf = async (client: Client, sheetId: string) =>
  (await call(client, 'read_rows', { sheet_id: sheetId })).rows as Array<{ id: string; data: Record<string, string> }>

// Auto-run follows within a moment (a kick after the write, the harness sweep every 500 ms).
async function waitForCell(client: Client, sheetId: string, row: number, column: string, want: string) {
  await expect.poll(async () => (await rowsOf(client, sheetId))[row].data[column] ?? '', { timeout: 10_000 })
    .toBe(want)
}

test('clean_column: preview, create, counts, change, refusals', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const sheetId = await seedPeople(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e clean'), 'e2e-clean')

  const tools = (await client.listTools()).tools.map(t => t.name)
  expect(tools).toContain('clean_column')

  const preview = await call(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Name', cleaner: 'first_name', preview: true })
  expect(preview.column).toBe('Name (first name)')
  expect(preview.samples.map((s: any) => s.after)).toEqual(['John', 'Jane', 'Mary'])
  expect((await call(client, 'get_sheet', { sheet_id: sheetId })).columns).not.toContain('Name (first name)')

  const name = await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Name', cleaner: 'person_name' })
  expect(name).toMatchObject({ column: 'Name (clean)', created: true, status: 'done', cleaned_rows: 3, auto_run: true })
  const email = await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Email', cleaner: 'email' })
  expect(email).toMatchObject({ cleaned_rows: 2, blank_rows: 1 })
  await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Website', cleaner: 'domain' })
  await call(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Phone', cleaner: 'phone', phone_format: 'e164', column: 'Phone E164' })

  const rows = await rowsOf(client, sheetId)
  expect(rows.map(r => r.data['Name (clean)'])).toEqual(['John Smith', 'Jane Doe', 'Mary O\'Brien'])
  expect(rows.map(r => r.data['Email (clean)'] ?? '')).toEqual(['john.smith@acme.com', '', 'pat@acme.co.uk'])
  expect(rows.map(r => r.data['Website (domain)'] ?? '')).toEqual(['acme.com', 'acme.co.uk', ''])
  expect(rows.map(r => r.data['Phone E164'] ?? '')).toEqual(['+12125550123', '', '+442079460958'])

  // The same call again changes nothing; a new cleaner on the clean column cleans every row again.
  expect(await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Name', cleaner: 'person_name' }))
    .toMatchObject({ created: false, status: 'done' })
  await call(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Name', cleaner: 'lowercase', column: 'Name (clean)' })
  expect((await rowsOf(client, sheetId))[0].data['Name (clean)']).toBe('smith, john')

  const meta = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(meta.clean_columns.find((c: any) => c.column === 'Phone E164'))
    .toMatchObject({ source_column: 'Phone', cleaner: 'phone', phone_format: 'e164', auto_run: true })

  // Refused: an existing column that isn't a clean column, the source itself, a loop, an unknown option.
  expect(await callError(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Name', cleaner: 'trim', column: 'Email' })).toContain('already a column')
  expect(await callError(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Name', cleaner: 'trim', column: 'Name' })).toContain('other than its source')
  await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Name (clean)', cleaner: 'trim', column: 'Y' })
  expect(await callError(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Y', cleaner: 'trim', column: 'Name (clean)' })).toContain("can't be cleaned")
  expect(await callError(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Name', cleaner: 'trim', phone_format: 'e164' })).toContain('phone')
  await client.close()
})

test('clean_column auto-run follows the source; a hand edit stays until the source changes', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const sheetId = await seedPeople(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e clean follow'), 'e2e-follow')
  await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Name', cleaner: 'person_name' })
  const ids = (await rowsOf(client, sheetId)).map(r => r.id)

  await call(client, 'update_cells', { row_id: ids[1], data: { Name: 'DOE, JANE Q.' } })
  await waitForCell(client, sheetId, 1, 'Name (clean)', 'Jane Q. Doe')

  await call(client, 'append_rows', { sheet_id: sheetId, rows: [{ Name: 'mr. bob jones jr' }] })
  await waitForCell(client, sheetId, 3, 'Name (clean)', 'Bob Jones')

  // A hand fix of the clean cell stays while its source is untouched...
  await call(client, 'update_cells', { row_id: ids[0], data: { 'Name (clean)': 'Johnny Smith' } })
  await call(client, 'update_cells', { row_id: ids[2], data: { Email: 'x@y.com' } })
  await new Promise(r => setTimeout(r, 1_500))
  expect((await rowsOf(client, sheetId))[0].data['Name (clean)']).toBe('Johnny Smith')
  // ...and gives way once the source changes.
  await call(client, 'update_cells', { row_id: ids[0], data: { Name: 'SMITH, JOHN A.' } })
  await waitForCell(client, sheetId, 0, 'Name (clean)', 'John A. Smith')

  // Off: the source changes, the clean column doesn't.
  const off = await call(client, 'set_auto_run', { sheet_id: sheetId, column: 'Name (clean)', enabled: false })
  expect(off.auto_run.find((a: any) => a.column === 'Name (clean)')).toMatchObject({ kind: 'clean', enabled: false })
  await call(client, 'update_cells', { row_id: ids[2], data: { Name: 'ZED ZULU' } })
  await new Promise(r => setTimeout(r, 1_500))
  expect((await rowsOf(client, sheetId))[2].data['Name (clean)']).toBe('Mary O\'Brien')
  // On again: every row is cleaned again first.
  await call(client, 'set_auto_run', { sheet_id: sheetId, column: 'Name (clean)', enabled: true })
  await waitForCell(client, sheetId, 2, 'Name (clean)', 'Zed Zulu')
  expect(await callError(client, 'set_auto_run',
    { sheet_id: sheetId, column: 'Name (clean)', enabled: true, daily_row_cap: 10 })).toContain('no rule or cap')
  await client.close()
})

test('clean columns follow renames and deletes', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const sheetId = await seedPeople(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e clean rename'), 'e2e-rename')
  await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Website', cleaner: 'domain' })
  await call(client, 'rename_column', { sheet_id: sheetId, column: 'Website', new_name: 'Site' })
  await call(client, 'rename_column', { sheet_id: sheetId, column: 'Website (domain)', new_name: 'Domain' })
  let clean = (await call(client, 'get_sheet', { sheet_id: sheetId })).clean_columns
  expect(clean).toEqual([expect.objectContaining({ column: 'Domain', source_column: 'Site' })])

  // The renamed pair still follows.
  const id = (await rowsOf(client, sheetId))[2].id
  await call(client, 'update_cells', { row_id: id, data: { Site: 'https://shop.example.com.au/x' } })
  await waitForCell(client, sheetId, 2, 'Domain', 'example.com.au')

  // Deleting the source keeps the values; deleting the clean column forgets it.
  await call(client, 'delete_column', { sheet_id: sheetId, column: 'Site' })
  expect((await rowsOf(client, sheetId))[0].data['Domain']).toBe('acme.com')
  const view = await (await api.get(`/api/sheets/${sheetId}?limit=10&offset=0`)).json()
  expect(view.data.autorun.columns['Domain']).toMatchObject({ kind: 'clean', pausedReason: 'missing_input' })
  await call(client, 'delete_column', { sheet_id: sheetId, column: 'Domain' })
  clean = (await call(client, 'get_sheet', { sheet_id: sheetId })).clean_columns
  expect(clean).toEqual([])
  await client.close()
})

test('REST: POST /api/v1/sheets/:id/clean-columns', async ({ playwright }) => {
  const api = await authedApi()
  const sheetId = await seedPeople(api)
  const rest = async (token: string) => playwright.request.newContext({
    baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
  const v1 = await rest(await makeAccessToken(api, ['read', 'write'], 'e2e clean rest'))
  const url = `/api/v1/sheets/${sheetId}/clean-columns`

  const preview = await v1.post(url, { data: { source_column: 'Email', cleaner: 'email', preview: true } })
  expect(preview.status()).toBe(200)
  expect((await preview.json()).samples[0].after).toBe('john.smith@acme.com')

  const created = await v1.post(url, { data: { source_column: 'Email', cleaner: 'email' } })
  expect(created.status()).toBe(201)
  expect(await created.json()).toMatchObject({ column: 'Email (clean)', status: 'done', blank_rows: 1 })
  expect((await v1.post(url, { data: { source_column: 'Email', cleaner: 'email' } })).status()).toBe(200)

  expect((await v1.post(url, { data: { source_column: 'Email', cleaner: 'nope' } })).status()).toBe(400)
  expect((await v1.post(url, { data: { source_column: 'Email', cleaner: 'email', colum: 'X' } })).status()).toBe(400)
  expect((await v1.post(url, { data: { source_column: 'Email', cleaner: 'email', column: 'Name' } })).status())
    .toBe(409)

  const readOnly = await rest(await makeAccessToken(api, ['read'], 'e2e clean read'))
  expect((await readOnly.post(url, { data: { source_column: 'Email', cleaner: 'email' } })).status()).toBe(403)
})

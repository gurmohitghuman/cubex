import { test, expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { sheetWith, waitSetup, column } from './helpers-setups'

// clean_column (MCP) and POST /api/v1/sheets/:id/clean-columns: free cleaning
// into a new column. Preview writes nothing; a call waits for the fill and
// returns its counts; calling again on a clean column changes it; any other
// existing column, the source itself and a loop are refused; auto-run follows
// the source (edits and new rows), a hand edit stays until the source changes;
// rename and delete keep the record in step; name_input and the_company are
// taken, echoed and refused alike over MCP and REST, follow new rows, and
// survive a setup; emoji and placeholders go over real rows.
// Over 200 lines: clean_column over MCP and REST is one area, scenario by scenario.

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

const NAME_ROWS = [
  { First: 'Dr. Sarah', Last: 'SMITH JONES', Company: 'The Christman Company', Name: 'Katie Siklitska 🇺🇦' },
  { First: 'J. Michael', Last: 'VAN DER BERG', Company: 'Docsumo 📄', Name: 'n/a' },
  { First: 'n/a', Last: 'Kowalski 👋', Company: 'ImagineSoftware (Technology Partners', Name: 'Ｍｉｃｈａｅｌ Smith' },
]
const FIRST_PAIR = 'name_input on the first_name cleaner must be full_name or first_name.'
const NAME_INPUT_ELSEWHERE = 'name_input is an option of the first_name cleaner (full_name or first_name) and the '
  + 'last_name cleaner (full_name or last_name) only.'

test('clean_column: name_input and the_company over MCP and REST, emoji and placeholders over rows', async ({
  playwright,
}) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await sheetWith(api, null, NAME_ROWS)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e clean names'), 'e2e-names')
  const cells = async (c: string) => (await rowsOf(client, sheetId)).map(r => r.data[c] ?? '')

  const tool = (await client.listTools()).tools.find(t => t.name === 'clean_column')!
  const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>
  expect(props.name_input.enum).toEqual(['full_name', 'first_name', 'last_name'])
  expect(props.the_company.enum).toEqual(['strip', 'keep'])

  const first = await call(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'First', cleaner: 'first_name', name_input: 'first_name' })
  expect(first).toMatchObject({ name_input: 'first_name', status: 'done', cleaned_rows: 2, blank_rows: 1 })
  expect(await cells('First (first name)')).toEqual(['Sarah', 'Michael', ''])
  await call(client, 'clean_column', { sheet_id: sheetId, source_column: 'Last', cleaner: 'last_name',
    name_input: 'last_name' })
  expect(await cells('Last (last name)')).toEqual(['Smith Jones', 'van der Berg', 'Kowalski'])
  const person = await call(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Name', cleaner: 'person_name' })
  expect(person).toMatchObject({ cleaned_rows: 2, blank_rows: 1 })
  expect(person.name_input).toBeUndefined()
  expect(await cells('Name (clean)')).toEqual(['Katie Siklitska', '', 'Michael Smith'])

  // Refused with the service's words (nothing written); a value outside the list by the input schema.
  expect(await callError(client, 'clean_column', { sheet_id: sheetId, source_column: 'First', cleaner: 'first_name',
    name_input: 'last_name', column: 'X' })).toBe(FIRST_PAIR)
  expect(await callError(client, 'clean_column', { sheet_id: sheetId, source_column: 'Name', cleaner: 'person_name',
    name_input: 'full_name', column: 'X' })).toBe(NAME_INPUT_ELSEWHERE)
  const outside = await client.callTool({ name: 'clean_column', arguments: { sheet_id: sheetId,
    source_column: 'First', cleaner: 'first_name', name_input: 'nickname', column: 'X' } }) as any
  expect(outside.isError).toBe(true)
  expect(outside.content[0].text).toContain('name_input')
  expect(outside.content[0].text).toContain('"full_name"')
  expect((await call(client, 'get_sheet', { sheet_id: sheetId })).columns).not.toContain('X')

  // Auto-run follows a new row with the column's option.
  await call(client, 'append_rows', { sheet_id: sheetId, rows: [{ First: 'Mr John' }] })
  await waitForCell(client, sheetId, 3, 'First (first name)', 'John')

  // REST: the_company keep, echoed; the same refusals as MCP, as 400s.
  const v1 = await playwright.request.newContext({ baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'e2e names rest')}` } })
  const url = `/api/v1/sheets/${sheetId}/clean-columns`
  const made = await v1.post(url, { data: { source_column: 'Company', cleaner: 'company_name', the_company: 'keep' } })
  expect(made.status()).toBe(201)
  expect(await made.json()).toMatchObject({ the_company: 'keep', status: 'done', cleaned_rows: 3 })
  expect(await cells('Company (clean)')).toEqual(['The Christman Company', 'Docsumo', 'ImagineSoftware', ''])
  for (const [data, error] of [
    [{ source_column: 'First', cleaner: 'first_name', name_input: 'last_name', column: 'X' }, FIRST_PAIR],
    [{ source_column: 'First', cleaner: 'first_name', name_input: 'nickname', column: 'X' }, FIRST_PAIR],
    [{ source_column: 'Company', cleaner: 'company_name', the_company: 'drop', column: 'X' },
      'the_company must be strip or keep.'],
  ] as const) {
    const res = await v1.post(url, { data })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toBe(error)
  }
  const meta = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(meta.clean_columns.find((c: any) => c.column === 'First (first name)'))
    .toMatchObject({ name_input: 'first_name' })
  expect(meta.clean_columns.find((c: any) => c.column === 'Company (clean)')).toMatchObject({ the_company: 'keep' })
  await client.close()
})

test('clean_column options survive a setup saved and used on another sheet', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e clean setup'), 'e2e-cs')
  const a = await sheetWith(api, null, [{ First: 'Dr. Sarah', Company: 'The Christman Company' }])
  await call(client, 'clean_column', { sheet_id: a.sheetId, source_column: 'First', cleaner: 'first_name',
    name_input: 'first_name', column: 'Given' })
  await call(client, 'clean_column', { sheet_id: a.sheetId, source_column: 'Company', cleaner: 'company_name',
    the_company: 'keep', column: 'Firm' })
  const setup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Names', columns: ['Given', 'Firm'] })

  const b = await sheetWith(api, a.tableId, [
    { First: 'Mr John', Company: 'THE CHRISTMAN COMPANY, INC.' }, { First: 'MARY ANN', Company: 'Acme Inc' },
  ])
  const started = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, estimate_only: false })
  expect((await waitSetup(client, started.setup_run.id)).status).toBe('done')
  expect((await column(api, b.sheetId, 'Given')).slice(0, 2)).toEqual(['John', 'Mary Ann'])
  expect((await column(api, b.sheetId, 'Firm')).slice(0, 2)).toEqual(['The Christman Company', 'Acme'])
  const meta = await call(client, 'get_sheet', { sheet_id: b.sheetId })
  expect(meta.clean_columns.find((c: any) => c.column === 'Given')).toMatchObject({ name_input: 'first_name' })
  expect(meta.clean_columns.find((c: any) => c.column === 'Firm')).toMatchObject({ the_company: 'keep' })
  await client.close()
})

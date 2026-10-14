import { test, expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// formula_column (MCP) and POST /api/v1/sheets/:id/formula-columns: a column
// worked out for free from each row by a JavaScript formula. A Response column
// holds a whole API response as JSON text (what an HTTP run mapping "$"
// writes), and the formula picks an item by a condition, which JSONPath
// refuses. Preview writes nothing; a call waits for the fill and returns its
// counts; a row the formula can't work out shows its error; refusals; auto-run
// follows every input; rename and delete keep the record in step.

const reply = (work: string | null) => JSON.stringify({
  emails: [{ type: 'personal', value: 'me@gmail.com' }, ...(work ? [{ type: 'work', value: work }] : [])],
})
const SEED = [
  { Response: reply('ada@acme.com'), First: 'Ada', Last: 'Lovelace', Score: '7' },
  { Response: reply(null), First: 'Grace', Last: 'Hopper', Score: '9' },
  { Response: '', First: 'Alan', Last: 'Turing', Score: 'n/a' },
]
const WORK = '{{Response}}?.emails?.find(e => e.type == "work")?.value'

async function seedPeople(api: APIRequestContext): Promise<string> {
  const { sheetId } = await seedSheet(api, SEED.length)
  for (const c of ['Response', 'First', 'Last', 'Score']) {
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
  await expect.poll(async () => (await rowsOf(client, sheetId))[row]?.data[column] ?? '', { timeout: 10_000 })
    .toBe(want)
}

test('formula_column: preview, create, errors, change, refusals', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const sheetId = await seedPeople(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e formula'), 'e2e-formula')
  const tools = (await client.listTools()).tools.map(t => t.name)
  expect(tools).toEqual(expect.arrayContaining(['formula_column', 'write_formula']))

  const preview = await call(client, 'formula_column',
    { sheet_id: sheetId, formula: WORK.replace('Response', 'response'), preview: true })
  expect(preview.formula).toBe(WORK)
  expect(preview.reads).toEqual(['Response'])
  expect(preview.samples.map((s: any) => s.result)).toEqual(['ada@acme.com', ''])
  expect((await call(client, 'get_sheet', { sheet_id: sheetId })).columns).not.toContain('Work email')

  const work = await call(client, 'formula_column', { sheet_id: sheetId, column: 'Work email', formula: WORK })
  expect(work).toMatchObject({ column: 'Work email', created: true, status: 'done', filled_rows: 1, error_rows: 0,
    auto_run: true, reads: ['Response'] })
  const full = await call(client, 'formula_column',
    { sheet_id: sheetId, column: 'Full name', formula: '`${{{First}}} ${{{Last}}}`' })
  expect(full).toMatchObject({ filled_rows: 3 })
  const broken = await call(client, 'formula_column',
    { sheet_id: sheetId, column: 'Broken', formula: '{{Response}}.emails.find(e => e.type == "work").value' })
  expect(broken).toMatchObject({ status: 'done', filled_rows: 1, error_rows: 2 })
  expect(broken.first_error).toMatch(/^Row 2: TypeError/)

  let rows = await rowsOf(client, sheetId)
  expect(rows.map(r => r.data['Work email'] ?? '')).toEqual(['ada@acme.com', '', ''])
  expect(rows.map(r => r.data['Full name'])).toEqual(['Ada Lovelace', 'Grace Hopper', 'Alan Turing'])
  expect(rows[1].data['Broken']).toMatch(/^❌ TypeError/)

  // A new formula on the formula column works every row out again.
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Full name', formula: '{{Last}}.toUpperCase()' })
  rows = await rowsOf(client, sheetId)
  expect(rows.map(r => r.data['Full name'])).toEqual(['LOVELACE', 'HOPPER', 'TURING'])
  const meta = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(meta.formula_columns.find((c: any) => c.column === 'Full name'))
    .toMatchObject({ formula: '{{Last}}.toUpperCase()', reads: ['Last'], auto_run: true, status: 'done' })

  // Refused: an existing column, a syntax error, a misspelling, its own column, a loop with a clean column.
  expect(await callError(client, 'formula_column', { sheet_id: sheetId, column: 'First', formula: '1' }))
    .toContain('already a column')
  expect(await callError(client, 'formula_column', { sheet_id: sheetId, column: 'X', formula: '{{First}} +* 1' }))
    .toContain('SyntaxError')
  expect(await callError(client, 'formula_column', { sheet_id: sheetId, column: 'X', formula: '{{Frist}}' }))
    .toContain('Did you mean "First"')
  expect(await callError(client, 'formula_column',
    { sheet_id: sheetId, column: 'Full name', formula: '{{Full name}}' })).toContain('its own column')
  await call(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Full name', cleaner: 'lowercase', column: 'Y' })
  expect(await callError(client, 'formula_column', { sheet_id: sheetId, column: 'Full name', formula: '{{Y}}' }))
    .toContain('worked out from "Full name"')
  expect(await callError(client, 'formula_column', { sheet_id: sheetId, formula: '1' })).toContain('Name the formula')
  await client.close()
})

test('formula_column auto-run follows every input; a hand edit stays until an input changes', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const sheetId = await seedPeople(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e formula follow'), 'e2e-ff')
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Label', formula: '`${{{First}}} (${{{Score}}})`' })
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Work email', formula: WORK })
  const ids = (await rowsOf(client, sheetId)).map(r => r.id)

  await call(client, 'update_cells', { row_id: ids[1], data: { Score: '10' } })
  await waitForCell(client, sheetId, 1, 'Label', 'Grace (10)')
  await call(client, 'update_cells', { row_id: ids[1], data: { First: 'Rear Admiral Grace' } })
  await waitForCell(client, sheetId, 1, 'Label', 'Rear Admiral Grace (10)')
  // A response arriving later (as an HTTP run would write it) is followed too.
  await call(client, 'update_cells', { row_id: ids[2], data: { Response: reply('alan@bletchley.uk') } })
  await waitForCell(client, sheetId, 2, 'Work email', 'alan@bletchley.uk')
  await call(client, 'append_rows', { sheet_id: sheetId, rows: [{ First: 'Barbara', Score: '5' }] })
  await waitForCell(client, sheetId, 3, 'Label', 'Barbara (5)')

  await call(client, 'update_cells', { row_id: ids[0], data: { Label: 'hand fixed' } })
  await call(client, 'update_cells', { row_id: ids[0], data: { Last: 'King' } })
  await new Promise(r => setTimeout(r, 1_500))
  expect((await rowsOf(client, sheetId))[0].data['Label']).toBe('hand fixed')
  await call(client, 'update_cells', { row_id: ids[0], data: { Score: '8' } })
  await waitForCell(client, sheetId, 0, 'Label', 'Ada (8)')

  const off = await call(client, 'set_auto_run', { sheet_id: sheetId, column: 'Label', enabled: false })
  expect(off.auto_run.find((a: any) => a.column === 'Label')).toMatchObject({ kind: 'formula', enabled: false })
  await call(client, 'update_cells', { row_id: ids[2], data: { Score: '1' } })
  await new Promise(r => setTimeout(r, 1_500))
  expect((await rowsOf(client, sheetId))[2].data['Label']).toBe('Alan (n/a)')
  await call(client, 'set_auto_run', { sheet_id: sheetId, column: 'Label', enabled: true })
  await waitForCell(client, sheetId, 2, 'Label', 'Alan (1)')
  expect(await callError(client, 'set_auto_run',
    { sheet_id: sheetId, column: 'Label', enabled: true, daily_row_cap: 10 })).toContain('no rule or cap')
  await client.close()
})

test('formula columns follow renames and deletes', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const sheetId = await seedPeople(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e formula rename'), 'e2e-fr')
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Work email', formula: WORK })
  await call(client, 'rename_column', { sheet_id: sheetId, column: 'Response', new_name: 'API reply' })
  await call(client, 'rename_column', { sheet_id: sheetId, column: 'Work email', new_name: 'Work' })
  let formulas = (await call(client, 'get_sheet', { sheet_id: sheetId })).formula_columns
  expect(formulas).toEqual([expect.objectContaining({ column: 'Work', reads: ['API reply'],
    formula: '{{API reply}}?.emails?.find(e => e.type == "work")?.value' })])

  const id = (await rowsOf(client, sheetId))[1].id
  await call(client, 'update_cells', { row_id: id, data: { 'API reply': reply('grace@navy.mil') } })
  await waitForCell(client, sheetId, 1, 'Work', 'grace@navy.mil')

  // Deleting an input keeps the values and pauses auto-run; deleting the formula column forgets it.
  await call(client, 'delete_column', { sheet_id: sheetId, column: 'API reply' })
  expect((await rowsOf(client, sheetId))[0].data['Work']).toBe('ada@acme.com')
  const view = await (await api.get(`/api/sheets/${sheetId}?limit=10&offset=0`)).json()
  expect(view.data.autorun.columns['Work']).toMatchObject({ kind: 'formula', pausedReason: 'missing_input' })
  expect(view.data.columnTypes['Work']).toBe('formula')
  await call(client, 'delete_column', { sheet_id: sheetId, column: 'Work' })
  formulas = (await call(client, 'get_sheet', { sheet_id: sheetId })).formula_columns
  expect(formulas).toEqual([])
  await client.close()
})

test('REST: POST /api/v1/sheets/:id/formula-columns and /write', async ({ playwright }) => {
  const api = await authedApi()
  const sheetId = await seedPeople(api)
  const rest = async (token: string) => playwright.request.newContext({
    baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
  const v1 = await rest(await makeAccessToken(api, ['read', 'write'], 'e2e formula rest'))
  const url = `/api/v1/sheets/${sheetId}/formula-columns`

  const preview = await v1.post(url, { data: { formula: WORK, preview: true } })
  expect(preview.status()).toBe(200)
  expect((await preview.json()).samples[0].result).toBe('ada@acme.com')
  const created = await v1.post(url, { data: { formula: WORK, column: 'Work email' } })
  expect(created.status()).toBe(201)
  expect(await created.json()).toMatchObject({ column: 'Work email', status: 'done', filled_rows: 1 })
  expect((await v1.post(url, { data: { formula: WORK, column: 'Work email' } })).status()).toBe(200)
  expect((await v1.post(url, { data: { formula: '{{Nope}}', column: 'X' } })).status()).toBe(400)
  expect((await v1.post(url, { data: { formula: '1', column: 'X', colum: 'Y' } })).status()).toBe(400)
  expect((await v1.post(url, { data: { formula: '1', column: 'First' } })).status()).toBe(409)

  // Writing with AI spends money: the run scope. The harness has no usable model or key, so it says
  // why (400: no model or key; 502: the model didn't answer).
  expect((await v1.post(`${url}/write`, { data: { words: 'the work email' } })).status()).toBe(403)
  const runner = await rest(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e formula write'))
  const write = await runner.post(`${url}/write`, { data: { words: 'the work email' } })
  expect([400, 502]).toContain(write.status())
  expect((await write.json()).error).toBeTruthy()

  const readOnly = await rest(await makeAccessToken(api, ['read'], 'e2e formula read'))
  expect((await readOnly.post(url, { data: { formula: '1', column: 'Z' } })).status()).toBe(403)
})

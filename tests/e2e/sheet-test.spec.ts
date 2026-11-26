// Trying column changes on sample rows over REST, MCP and the public webhook (services/sheet-test-*.ts): a test
// copies the top rows and the setup into a copy that no list shows; the sheet then refuses a cell edit (busy, as
// autosave retries it), an append and a run, while reads go on; a webhook event gets its usual 202 and waits; a
// formula changed in the copy shows in a dry apply; applying makes it the sheet's (worked out again on every row)
// and adds the kept event; applying needs 'run'; discarding leaves the sheet as it was.
import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, importCsv, getSheet } from './helpers'
import { bearer, makeToken } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'

let api: APIRequestContext
let v1: APIRequestContext
let token: string

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  api = await authedApi()
  token = await makeToken(api, ['read', 'write', 'run'], 'sheet test spec')
  v1 = await bearer(token)
})
test.afterAll(async () => { await v1?.dispose() })

const csv = 'Name,Website\n' + Array.from({ length: 15 }, (_, i) => `name${i},site${i}.com`).join('\n') + '\n'
const rowsOf = async (sheetId: string) =>
  ((await getSheet(api, sheetId)).data.rows as Array<{ data: Record<string, string> }>).map(r => r.data)

test('REST and MCP: test on 5 rows, the sheet waits, apply makes the change the sheet\'s', async () => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  const client = await mcpClient(token)
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Short', formula: '{{Name}}.slice(0, 2)' })
  await expect.poll(async () => (await rowsOf(sheetId))[14]?.Short).toBe('na')
  const hook = await api.post(`/api/sheets/${sheetId}/webhook`, { data: { name: 'e2e test hold' } })
  expect(hook.status()).toBe(201)
  const url: string = (await hook.json()).source.url
  const mapped = await api.post(`/api/sheets/${sheetId}/webhook/mappings`, { data: { jsonPath: '$.lead',
    columnName: 'Lead' } })
  expect(mapped.ok(), await mapped.text()).toBeTruthy()

  const started = await v1.post(`/api/v1/sheets/${sheetId}/test`, { data: { rows: 5 } })
  expect(started.status(), await started.text()).toBe(201)
  const copyId: string = (await started.json()).test.test_sheet_id
  expect((await rowsOf(copyId)).map(r => r.Name)).toEqual(['name0', 'name1', 'name2', 'name3', 'name4'])
  const tabs = await (await api.get(`/api/tables/${tableId}`)).json()
  expect(tabs.sheets.map((s: { id: string }) => s.id)).toEqual([sheetId])
  const listed = await call(client, 'get_workspace', { all_tables: true })
  expect(JSON.stringify(listed)).not.toContain(copyId)

  // The sheet: a cell edit is busy (autosave retries it), an append and a run are refused, reads go on.
  const cell = (columnName: string, value: string) => ({ data: { updates: [{ rowIndex: 0, columnName, value }] } })
  const edit = await api.put(`/api/sheets/${sheetId}/data`, cell('Name', 'x'))
  expect(edit.status()).toBe(409)
  expect((await edit.json()).busy).toBe(true)
  expect((await v1.post(`/api/v1/sheets/${sheetId}/rows`, { data: { rows: [{ Name: 'y' }] } })).status()).toBe(409)
  const formulaRefused = await callError(client, 'formula_column', { sheet_id: sheetId, column: 'Other',
    formula: '{{Name}}' })
  expect(formulaRefused).toMatch(/testing changes on sample rows/)
  expect((await rowsOf(sheetId)).length).toBe(15)
  const sheet = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(sheet.test.test_sheet_id).toBe(copyId)

  // A webhook event: the usual 202, kept until the test ends.
  const anon = await pwRequest.newContext()
  expect((await anon.post(url, { headers: { 'Content-Type': 'application/json' }, data: { lead: 'late' } })).status())
    .toBe(202)
  await anon.dispose()
  expect((await rowsOf(sheetId)).length).toBe(15)

  // In the copy: a new formula, worked out there.
  await call(client, 'formula_column', { sheet_id: copyId, column: 'Short', formula: '{{Name}}.slice(0, 5)' })
  await expect.poll(async () => (await rowsOf(copyId))[0]?.Short).toBe('name0')

  const dry = await call(client, 'manage_sheet', { action: 'apply_test', table_id: tableId, sheet_id: sheetId })
  expect(dry.apply.dry_run).toBe(true)
  expect(dry.apply.worked_out_again).toEqual(['Short'])
  expect((await rowsOf(sheetId))[0].Short).toBe('na')

  const applied = await call(client, 'manage_sheet', { action: 'apply_test', table_id: tableId, sheet_id: sheetId,
    dry_run: false })
  expect(applied.apply.saved_before).toBeTruthy()
  await expect.poll(async () => (await rowsOf(sheetId)).map(r => r.Lead).slice(-1)).toEqual(['late'])
  await expect.poll(async () => (await rowsOf(sheetId))[14]?.Short, { timeout: 20_000 }).toBe('name1')
  await expect.poll(async () => (await (await v1.get(`/api/v1/sheets/${sheetId}/test`)).json()).test).toBeNull()
  expect((await api.put(`/api/sheets/${sheetId}/data`, cell('Website', 'z'))).status()).toBe(200)
})

test('applying needs the run scope; discarding leaves the sheet as it was', async () => {
  test.setTimeout(60_000)
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  const before = await rowsOf(sheetId)
  const started = await v1.post(`/api/v1/sheets/${sheetId}/test`, { data: { rows: 3 } })
  expect(started.status()).toBe(201)
  const writer = await bearer(await makeToken(api, ['read', 'write'], 'sheet test no run'))
  const refused = await writer.post(`/api/v1/sheets/${sheetId}/test/apply`, { data: { dry_run: false } })
  expect(refused.status()).toBe(403)
  expect((await writer.post(`/api/v1/sheets/${sheetId}/test/apply`, { data: {} })).status()).toBe(200)
  const client = await mcpClient(token)
  await call(client, 'manage_sheet', { action: 'test_add_rows', table_id: tableId, sheet_id: sheetId, how: 'random',
    rows: 2 })
  await call(client, 'manage_sheet', { action: 'discard_test', table_id: tableId, sheet_id: sheetId })
  await expect.poll(async () => (await (await v1.get(`/api/v1/sheets/${sheetId}/test`)).json()).test).toBeNull()
  expect(await rowsOf(sheetId)).toEqual(before)
  await writer.dispose()
})

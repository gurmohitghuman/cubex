import { test, expect } from '@playwright/test'
import { BASE, authedApi, getSheet, importCsv, makeAccessToken, seedSheet } from './helpers'
import { mcpClient, call } from './helpers-mcp'

// A CSV with columns named "__proto__", "constructor" and "prototype" (names an object can't hold as plain keys)
// imports like any other, through MCP import_csv, an upload link, REST and the app: each becomes a column of its
// own name, and its cells read back as sent, over MCP and in the app.
const CSV = 'Name,__proto__,constructor,prototype\nAda,p1,c1,t1\nBo,p2,c2,t2\n'
const NAMES = ['__proto__', 'constructor', 'prototype']
// The new sheet's empty starter row is left out.
const expectRows = (rows: Array<Record<string, string>>) => {
  const cell = (r: Record<string, string>, k: string) => (Object.hasOwn(r, k) ? r[k] : undefined)
  expect(rows.filter(r => cell(r, 'Name')).map(r => ['Name', ...NAMES].map(k => cell(r, k))))
    .toEqual([['Ada', 'p1', 'c1', 't1'], ['Bo', 'p2', 'c2', 't2']])
}
// The cells of a read_rows answer, as own keys (JSON.parse keeps "__proto__" as one).
const own = (data: Record<string, string>) => Object.fromEntries(Object.entries(data))

test('a CSV with __proto__, constructor and prototype columns imports through every path', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read', 'write'], `object-keys-${Date.now()}`)
  const client = await mcpClient(token)
  const auth = { Authorization: `Bearer ${token}` }
  const readBack = async (sheetId: string) =>
    (await call(client, 'read_rows', { sheet_id: sheetId })).rows.map((r: any) => own(r.data))

  // MCP import_csv.
  const a = (await seedSheet(api, 0)).sheetId
  const viaMcp = await call(client, 'import_csv', { sheet_id: a, csv: CSV })
  expect(viaMcp.rows_imported).toBe(2)
  expect(viaMcp.new_columns).toEqual(expect.arrayContaining(NAMES))
  expectRows(await readBack(a))

  // An upload link.
  const b = (await seedSheet(api, 0)).sheetId
  const link = await call(client, 'file_link', { action: 'upload', sheet_id: b })
  const up = await api.put(link.upload_url, { data: Buffer.from(CSV), headers: { 'Content-Type': 'text/csv' } })
  expect(up.status(), await up.text()).toBe(201)
  expectRows(await readBack(b))

  // REST.
  const c = (await seedSheet(api, 0)).sheetId
  const rest = await api.post(`${BASE}/api/v1/sheets/${c}/import`, { headers: auth,
    multipart: { file: { name: 'keys.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) } } })
  expect(rest.status(), await rest.text()).toBe(201)
  expectRows(await readBack(c))

  // The app: imported, and the sheet it shows has the columns and cells.
  const d = (await seedSheet(api, 0)).sheetId
  const app = await importCsv(api, d, CSV, { replaceData: true })
  expect(app.ok(), await app.text()).toBeTruthy()
  const sheet = await getSheet(api, d)
  expect(sheet.data.columns).toEqual(expect.arrayContaining(NAMES))
  expectRows(sheet.data.rows.map((r: any) => own(r.data)))
})

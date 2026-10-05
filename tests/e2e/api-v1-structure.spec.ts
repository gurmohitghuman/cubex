import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// /api/v1 structure ops (step 2b): table CRUD, sheet (tab) CRUD + last-sheet
// guard + reorder, physical sort (row_generation + data_version semantics),
// CSV export.


// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext, scopes: string[], name: string): Promise<string> {
  return makeAccessToken(api, scopes, name)
}

function bearer(token: string) {
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
}

test('v1 tables + sheets CRUD: create/rename/reorder/delete, guards', async () => {
  const api = await authedApi()
  // Clean slate: every spec shares the one account.
  const existing = await (await api.get('/api/tables')).json()
  for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const v1 = await bearer(await makeToken(api, ['read', 'write'], 'e2e v1 struct'))

  // Table create → 201 with its first sheet; duplicate name → 409.
  const t1 = await v1.post('/api/v1/tables', { data: { name: 'V1 Table' } })
  expect(t1.status()).toBe(201)
  const table = await t1.json()
  expect(table.sheets[0]).toMatchObject({ name: 'Sheet1', position: 0 })
  expect((await v1.post('/api/v1/tables', { data: { name: 'V1 Table' } })).status()).toBe(409)

  // No table cap: a 2nd and 3rd table are fine.
  const t2 = await v1.post('/api/v1/tables', { data: { name: 'V1 Table B' } })
  expect(t2.status()).toBe(201)
  const tableB = await t2.json()
  expect((await v1.post('/api/v1/tables', { data: { name: 'V1 Table C' } })).status()).toBe(201)

  // Rename table; conflict → 409.
  expect((await v1.patch(`/api/v1/tables/${table.id}`, { data: { name: 'Renamed' } })).status()).toBe(200)
  expect((await v1.patch(`/api/v1/tables/${table.id}`, { data: { name: 'V1 Table B' } })).status()).toBe(409)

  // Sheets: no per-table cap (a 4th tab is fine); name conflict → 409.
  const s2 = await v1.post(`/api/v1/tables/${table.id}/sheets`, { data: { name: 'Tab2' } })
  expect(s2.status()).toBe(201)
  const s3 = await v1.post(`/api/v1/tables/${table.id}/sheets`, { data: {} }) // auto-name
  expect(s3.status()).toBe(201)
  expect((await v1.post(`/api/v1/tables/${table.id}/sheets`, { data: { name: 'Tab4' } })).status()).toBe(201)
  expect((await v1.post(`/api/v1/tables/${tableB.id}/sheets`, {
    data: { name: 'Sheet1' },
  })).status()).toBe(409)

  // Reorder: reversed ids; mismatched set → 400.
  const sheetsNow = (await (await v1.get('/api/v1/tables')).json())
    .tables.find((t: any) => t.id === table.id).sheets
  const reversed = sheetsNow.map((s: any) => s.id).reverse()
  const reorder = await v1.patch(`/api/v1/tables/${table.id}/sheets/order`, {
    data: { ordered_sheet_ids: reversed },
  })
  expect(reorder.status()).toBe(200)
  expect((await reorder.json()).sheets.map((s: any) => s.id)).toEqual(reversed)
  expect((await v1.patch(`/api/v1/tables/${table.id}/sheets/order`, {
    data: { ordered_sheet_ids: reversed.slice(1) },
  })).status()).toBe(400)

  // Sheet rename + conflict; delete down to the last-sheet guard.
  const sid = reversed[0]
  expect((await v1.patch(`/api/v1/tables/${table.id}/sheets/${sid}`, { data: { name: 'First' } })).status()).toBe(200)
  expect((await v1.patch(`/api/v1/tables/${table.id}/sheets/${sid}`, { data: { name: 'Tab2' } }))
    .status()).toBe(409)
  expect((await v1.delete(`/api/v1/tables/${table.id}/sheets/${reversed[1]}`)).status()).toBe(200)
  expect((await v1.delete(`/api/v1/tables/${table.id}/sheets/${reversed[2]}`)).status()).toBe(200)
  expect((await v1.delete(`/api/v1/tables/${table.id}/sheets/${reversed[3]}`)).status()).toBe(200)
  expect((await v1.delete(`/api/v1/tables/${table.id}/sheets/${sid}`)).status()).toBe(400) // last sheet

  // Table delete; read-only token can't mutate structure.
  expect((await v1.delete(`/api/v1/tables/${table.id}`)).status()).toBe(200)
  const ro = await bearer(await makeToken(api, ['read'], 'e2e v1 struct ro'))
  expect((await ro.post('/api/v1/tables', { data: { name: 'Nope' } })).status()).toBe(403)
  await ro.dispose()
  await v1.dispose()
})

test('UI column routes still honor their contract after the service extraction', async () => {
  // tests/e2e/column-order.spec.ts (the original coverage) is a stale
  // pre-branch spec that fails at setup on any commit; this locks the
  // refactored thin wrappers (session-cookie routes) to their old contract.
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2) // 'val'
  expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'zed' } })).ok()).toBeTruthy()

  // Rename via the UI route: collision → 400 (historical status), rename works.
  expect((await api.put(`/api/sheets/${sheetId}/columns/zed`, { data: { newName: 'VAL' } })).status()).toBe(400)
  expect((await api.put(`/api/sheets/${sheetId}/columns/zed`, { data: { newName: 'alpha' } })).status()).toBe(200)

  // Reorder via the UI route: partial order → 400, full order persists.
  expect((await api.put(`/api/sheets/${sheetId}/columns/reorder`, { data: { columnOrder: ['alpha'] } })).status()).toBe(400)
  expect((await api.put(`/api/sheets/${sheetId}/columns/reorder`, { data: { columnOrder: ['alpha', 'val'] } })).status()).toBe(200)
  const sheet = await (await api.get(`/api/sheets/${sheetId}?limit=10&offset=0`)).json()
  expect(sheet.data.columns).toEqual(['alpha', 'val'])

  // Delete via the UI route: unknown → 404, real → 200, last column → 400.
  expect((await api.delete(`/api/sheets/${sheetId}/columns/ghost`)).status()).toBe(404)
  expect((await api.delete(`/api/sheets/${sheetId}/columns/alpha`)).status()).toBe(200)
  expect((await api.delete(`/api/sheets/${sheetId}/columns/val`)).status()).toBe(400)
})

test('v1 CSV import: append merges columns; replace bumps generation', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2) // val: v0, v1
  const v1 = await bearer(await makeToken(api, ['read', 'write'], 'e2e v1 csv'))

  // Append: rows land after existing; new column registered.
  const app = await v1.post(`/api/v1/sheets/${sheetId}/import`, {
    multipart: {
      file: { name: 'more.csv', mimeType: 'text/csv', buffer: Buffer.from('val,city\nx1,Berlin\nx2,Paris\n') },
      replace: 'false',
    },
  })
  expect(app.status()).toBe(201)
  const appBody = await app.json()
  expect(appBody.rows_imported).toBe(2)
  expect(appBody.new_columns).toContain('city')
  const meta = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta.row_count).toBe(4)
  expect(meta.columns).toEqual(['val', 'city'])

  // Replace: fresh column set, 1 row; row_generation AND data_version move
  // (open tabs loud-reload via the change poll).
  const before = await (await api.get(`/api/sheets/${sheetId}/changes?since=-1`)).json()
  const rep = await v1.post(`/api/v1/sheets/${sheetId}/import`, {
    multipart: {
      file: { name: 'fresh.csv', mimeType: 'text/csv', buffer: Buffer.from('company\nAcme\n') },
      replace: 'true',
    },
  })
  expect(rep.status()).toBe(201)
  const meta2 = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta2.columns).toEqual(['company'])
  expect(meta2.row_count).toBe(1)
  const after = await (await api.get(`/api/sheets/${sheetId}/changes?since=-1`)).json()
  expect(after.rowGeneration).toBeGreaterThan(before.rowGeneration)
  expect(after.dataVersion).toBeGreaterThan(before.dataVersion)

  // Non-CSV extension → 400; read-only token → 403.
  expect((await v1.post(`/api/v1/sheets/${sheetId}/import`, {
    multipart: { file: { name: 'x.txt', mimeType: 'text/csv', buffer: Buffer.from('a\n1\n') } },
  })).status()).toBe(400)
  const ro = await bearer(await makeToken(api, ['read'], 'e2e v1 csv ro'))
  expect((await ro.post(`/api/v1/sheets/${sheetId}/import`, {
    multipart: { file: { name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from('a\n1\n') } },
  })).status()).toBe(403)
  await ro.dispose(); await v1.dispose()
})

test('v1 sort: physical reorder, dv + generation bump; export CSV', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3) // val: v0, v1, v2
  const v1 = await bearer(await makeToken(api, ['read', 'write'], 'e2e v1 sortx'))

  // Make values unsorted: v2, v0, v1 by patching via row ids.
  const before = await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()
  const [r0, r1, r2] = before.rows
  await v1.patch(`/api/v1/rows/${r0.id}`, { data: { data: { val: 'v2' } } })
  await v1.patch(`/api/v1/rows/${r1.id}`, { data: { data: { val: 'v0' } } })
  await v1.patch(`/api/v1/rows/${r2.id}`, { data: { data: { val: 'v1' } } })
  const meta1 = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()

  // Sort asc: same row ids, new physical order; dv bumped.
  const sort = await v1.post(`/api/v1/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'asc' } })
  expect(sort.status()).toBe(200)
  expect((await sort.json()).rows_reordered).toBe(3)
  const after = await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()
  expect(after.rows.map((r: any) => r.data.val)).toEqual(['v0', 'v1', 'v2'])
  expect(after.rows.map((r: any) => r.id).sort()).toEqual([r0.id, r1.id, r2.id].sort())
  const meta2 = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta2.data_version).toBeGreaterThan(meta1.data_version)

  // Unknown column → 404; bad direction → 400.
  expect((await v1.post(`/api/v1/sheets/${sheetId}/sort`, { data: { column: 'nope', direction: 'asc' } })).status()).toBe(404)
  expect((await v1.post(`/api/v1/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'up' } })).status()).toBe(400)

  // Export: header + 3 sorted data lines.
  const exp = await v1.get(`/api/v1/sheets/${sheetId}/export`)
  expect(exp.status()).toBe(200)
  expect(exp.headers()['content-type']).toContain('text/csv')
  const lines = (await exp.text()).split('\r\n')
  expect(lines[0]).toContain('val')
  expect(lines).toHaveLength(4)
  await v1.dispose()
})

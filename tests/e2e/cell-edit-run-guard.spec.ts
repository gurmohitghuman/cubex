import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test'

// E2E guard: PUT /:id/data must DROP cell edits that target a column an active
// AI/HTTP run is writing into (the worker is the authoritative writer there until
// the run ends — racing it would let the worker overwrite the edit, or the edit
// clobber an in-flight result). Unlike sort/bulk-delete, this is COLUMN-scoped, not
// sheet-wide: PUT /:id/data is the single autosave driver, so a blanket 409 would
// strand every edit on the sheet for the whole run. Edits to OTHER columns must
// still persist; dropped columns come back in the response's `lockedColumns`.
// Server: server/src/routes/sheets-data.ts → getLockedRunColumns (sheets-shared.ts).
const BASE = process.env.E2E_BASE || 'http://localhost:3099'

async function authedApi(): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE })
  const res = await ctx.post('/api/auth/login', {
    data: { password: 'password123' },
  })
  if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`)
  return ctx
}

// Fresh table + sheet seeded with `val` + `other` columns, `rows` rows. The HTTP run
// CREATES its own master (`enrich`) + output (`enrich_out`) columns — neither may
// pre-exist (http-runs.ts rejects an existing master/extracted column). Clears prior
// tables (seed user is shared, cap 2).
async function seedSheet(api: APIRequestContext, rows: number): Promise<string> {
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const tbl = await api.post('/api/tables', { data: { name: `T_${Date.now()}_${Math.random()}` } })
  const sheetId = (await tbl.json()).sheets[0].id
  // Adding the first column creates a placeholder row 0; create the rest via
  // POST /rows BEFORE the value PUT — upsert mode writes into existing rows, it
  // does not create rows by index (it would otherwise resurrect deleted rows).
  for (const c of ['val', 'other']) {
    await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: c } })
  }
  if (rows > 1) await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: rows - 1 } })
  const updates = Array.from({ length: rows }, (_, i) => ([
    { rowIndex: i, columnName: 'val', value: `v${i}` },
    { rowIndex: i, columnName: 'other', value: `o${i}` },
  ])).flat()
  const put = await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })
  expect(put.ok()).toBeTruthy()
  return sheetId
}

// Read one cell's value back from the server.
async function cellValue(api: APIRequestContext, sheetId: string, rowIndex: number, col: string): Promise<string> {
  const res = await api.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)
  expect(res.ok()).toBeTruthy()
  const row = (await res.json()).data.rows.find((r: any) => r.rowIndex === rowIndex)
  return row?.data?.[col] ?? ''
}

// Start an HTTP run, then pause it so it sits in a guarded status ('paused')
// regardless of worker timing. The run record is INSERTED at start even with an
// unreachable URL, so no live API / OpenRouter key is needed. It writes into BOTH
// `enrich` (master — gets per-row status markers) and `enrich_out` (mapping).
async function startPausedHttpRun(api: APIRequestContext, sheetId: string): Promise<string> {
  const start = await api.post('/api/http/run', {
    data: {
      sheetId,
      masterColumnName: 'enrich',
      config: {
        requestConfig: { method: 'GET', url: 'https://example.com/{{val}}', headers: {}, body: '' },
        responseMapping: [{ columnName: 'enrich_out', jsonPath: '$.x' }],
      },
    },
  })
  expect(start.ok(), `http/run failed: ${start.status()} ${await start.text()}`).toBeTruthy()
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()
  const pause = await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'pause' } })
  expect(pause.ok()).toBeTruthy()
  return runId as string
}

// Serial: every spec shares the one account.
test.describe.configure({ mode: 'serial' })

test('cell edits to a run-locked column are dropped; other columns still save; unlocks after stop', async () => {
  const api = await authedApi()
  const sheetId = await seedSheet(api, 3)
  const runId = await startPausedHttpRun(api, sheetId)

  // Edit BOTH run-owned columns (master `enrich`, output `enrich_out`) AND an
  // unrelated column (`other`) in the same batch. The unrelated edit must persist;
  // both run-owned ones must be dropped and reported in `lockedColumns`.
  const put = await api.put(`/api/sheets/${sheetId}/data`, {
    data: {
      updates: [
        { rowIndex: 0, columnName: 'enrich', value: 'MANUAL_MASTER' },
        { rowIndex: 0, columnName: 'enrich_out', value: 'MANUAL_OUT' },
        { rowIndex: 0, columnName: 'other', value: 'CHANGED' },
      ],
    },
  })
  expect(put.ok()).toBeTruthy()
  const locked: string[] = (await put.json()).lockedColumns
  expect(locked).toContain('enrich')
  expect(locked).toContain('enrich_out')
  expect(locked).not.toContain('other')

  // The unrelated column saved; the run-owned ones kept their run-set value
  // (the "⏳ Processing..." placeholder run-start wrote), NOT the manual edit.
  expect(await cellValue(api, sheetId, 0, 'other')).toBe('CHANGED')
  expect(await cellValue(api, sheetId, 0, 'enrich')).not.toBe('MANUAL_MASTER')
  expect(await cellValue(api, sheetId, 0, 'enrich_out')).not.toBe('MANUAL_OUT')

  // An unrelated column edit on its own returns an empty lockedColumns list.
  const cleanEdit = await api.put(`/api/sheets/${sheetId}/data`, {
    data: { updates: [{ rowIndex: 1, columnName: 'val', value: 'INPUT_EDIT' }] },
  })
  expect(cleanEdit.ok()).toBeTruthy()
  expect((await cleanEdit.json()).lockedColumns).toEqual([])
  expect(await cellValue(api, sheetId, 1, 'val')).toBe('INPUT_EDIT')

  // Stop the run → the previously-locked columns now accept edits. Proves the run
  // was the cause of the drop, not some unrelated rejection.
  const cancel = await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'cancel' } })
  expect(cancel.ok()).toBeTruthy()
  const afterStop = await api.put(`/api/sheets/${sheetId}/data`, {
    data: { updates: [{ rowIndex: 0, columnName: 'enrich_out', value: 'NOW_OK' }] },
  })
  expect(afterStop.ok()).toBeTruthy()
  expect((await afterStop.json()).lockedColumns).toEqual([])
  expect(await cellValue(api, sheetId, 0, 'enrich_out')).toBe('NOW_OK')

  await api.dispose()
})

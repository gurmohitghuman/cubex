import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test'

// E2E guard: POST /:id/rows/bulk-delete must be rejected (409) while any AI/HTTP
// run is active on the sheet. A delete mid-run removes row_index values an
// in-flight worker is still writing to, orphaning {ai,http}_results that a later
// sort rebinds to the wrong live row (server/src/routes/sheets-rows-mutate.ts).
// Mirrors the long-standing sort guard (server/src/routes/sheets-sort.ts).
//
// Cookie auth with the harness's test password.
const BASE = process.env.E2E_BASE || 'http://localhost:3099'

async function authedApi(): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE })
  const res = await ctx.post('/api/auth/login', {
    data: { password: 'password123' },
  })
  if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`)
  return ctx
}

// Fresh table + sheet with `rows` rows in a single 'val' column. Mirrors the
// other specs' helper; clears prior tables (seed user is shared, cap 2).
async function seedSheet(api: APIRequestContext, rows: number): Promise<string> {
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const tbl = await api.post('/api/tables', { data: { name: `T_${Date.now()}_${Math.random()}` } })
  const sheetId = (await tbl.json()).sheets[0].id
  // Adding the first column creates a placeholder row 0; create the rest via
  // POST /rows BEFORE the value PUT — upsert mode writes into existing rows, it
  // does not create rows by index (it would otherwise resurrect deleted rows).
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'val' } })
  if (rows > 1) await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: rows - 1 } })
  const updates = Array.from({ length: rows }, (_, i) => ({ rowIndex: i, columnName: 'val', value: `v${i}` }))
  const put = await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })
  expect(put.ok()).toBeTruthy()
  return sheetId
}

async function totalRows(api: APIRequestContext, sheetId: string): Promise<number> {
  const res = await api.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.totalRows
}

// bulk-delete REQUIRES rowGeneration (destructive structural mutation — a hard
// 400 if omitted, unlike the back-compat PUT /data fence). Fetch the current
// generation so the delete is fenced, not rejected for the wrong reason.
async function rowGeneration(api: APIRequestContext, sheetId: string): Promise<number> {
  const res = await api.get(`/api/sheets/${sheetId}?limit=1&offset=0`)
  expect(res.ok()).toBeTruthy()
  return (await res.json()).sheet.row_generation
}

// Start an HTTP run on the sheet, then pause it so it sits in 'paused' (a guarded
// status) regardless of worker timing. HTTP is deterministic here: the run record
// is INSERTED at start time even with an unreachable URL — the failure happens
// later in the worker — so no OpenRouter key / live API is needed, and pausing
// removes any race with the worker completing the run.
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
  expect(start.ok()).toBeTruthy()
  const runId = (await start.json()).runId
  expect(runId).toBeTruthy()
  const pause = await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'pause' } })
  expect(pause.ok()).toBeTruthy()
  return runId as string
}

// Serial: every spec shares the one account.
test.describe.configure({ mode: 'serial' })

test('bulk-delete is rejected with 409 while a run is active, then succeeds once stopped', async () => {
  const api = await authedApi()
  const sheetId = await seedSheet(api, 5)
  const runId = await startPausedHttpRun(api, sheetId)

  const gen = await rowGeneration(api, sheetId)

  // Delete during the active run → 409 with the active-run message. It must NOT
  // be the row_generation 409 (that response carries a currentGeneration field;
  // the client disambiguates the two by exactly this field — useCellOps.ts).
  // A valid rowGeneration is sent so the 409 is unambiguously the active-run
  // guard, not the (also-409-shaped) stale-generation fence or a 400 for an
  // omitted generation.
  const blocked = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, {
    data: { rowIndices: [0, 1], rowGeneration: gen },
  })
  expect(blocked.status()).toBe(409)
  const body = await blocked.json()
  expect(body.error).toMatch(/run is active/i)
  expect(body.currentGeneration).toBeUndefined()

  // Rows untouched by the rejected delete.
  expect(await totalRows(api, sheetId)).toBe(5)

  // Stop the run → the same delete now succeeds. Proves the run was the cause of
  // the 409, not some unrelated rejection.
  const cancel = await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'cancel' } })
  expect(cancel.ok()).toBeTruthy()
  // Cancel doesn't touch row_index, so the generation is unchanged — reuse `gen`.
  const allowed = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, {
    data: { rowIndices: [0, 1], rowGeneration: gen },
  })
  expect(allowed.ok()).toBeTruthy()
  expect(await totalRows(api, sheetId)).toBe(3)

  await api.dispose()
})

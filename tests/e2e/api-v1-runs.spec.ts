import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { JSON_URL, makeToken, bearer, httpConfig, waitForTerminal } from './api-v1-run-helpers'

// /api/v1 Phase 2 — HTTP run lifecycle: start → poll → results → cells,
// rerun-by-run-id + superseded 409, target_row_ids subsets, and strict
// pause/resume/cancel codes. AI runs + scopes: api-v1-runs-ai.spec.ts;
// the secrets gate: api-v1-runs-secrets.spec.ts.

test.describe.configure({ mode: 'serial' })

test('v1 HTTP run: start → poll → results → cells; rerun by run id; superseded 409', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e v1 run'))

  const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: httpConfig(JSON_URL, 'Title'), master_column_name: 'Lookup' },
  })
  expect(start.status()).toBe(202)
  const started = await start.json()
  expect(started.master_column).toBe('Lookup')
  expect(started.mapped_columns).toEqual(['Title'])
  expect(started.target_rows).toBe(3)

  const done = await waitForTerminal(v1, `/api/v1/http-runs/${started.run_id}`)
  expect(done.status).toBe('completed')
  expect(done.processed_rows).toBe(3)
  expect(done.column_name).toBe('Lookup')

  // Per-row results carry stable row ids + extractions.
  const results = await (await v1.get(`/api/v1/http-runs/${started.run_id}/results`)).json()
  expect(results.results).toHaveLength(3)
  expect(results.results[0].status).toBe('completed')
  expect(typeof results.results[0].row_id).toBe('string')
  expect(results.results[0].extracted_fields.Title).toContain('delectus')

  // The cells landed (v1 rows read).
  const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows
  expect(rows[0].data.Title).toContain('delectus')
  expect(rows[0].data.Lookup).toContain('✅')

  // Rerun by run id (mode missing → nothing to redo → clean 400).
  const nothing = await v1.post(`/api/v1/http-runs/${started.run_id}/rerun`, { data: { mode: 'missing' } })
  expect(nothing.status()).toBe(400)

  // Full rerun → new run; the ORIGINAL id is now superseded → 409.
  const rerun = await v1.post(`/api/v1/http-runs/${started.run_id}/rerun`, { data: { mode: 'all' } })
  expect(rerun.status()).toBe(202)
  const rerunBody = await rerun.json()
  expect(rerunBody.run_id).not.toBe(started.run_id)
  await waitForTerminal(v1, `/api/v1/http-runs/${rerunBody.run_id}`)
  const superseded = await v1.post(`/api/v1/http-runs/${started.run_id}/rerun`, { data: { mode: 'all' } })
  expect(superseded.status()).toBe(409)

  await v1.dispose(); await api.dispose()
})

test('v1 HTTP run: target_row_ids runs ONLY those rows', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e v1 run'))

  const before = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows
  const targetIds = [before[0].id, before[2].id]

  const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: httpConfig(JSON_URL, 'T2'), master_column_name: 'Sub', target_row_ids: targetIds },
  })
  expect(start.status()).toBe(202)
  const started = await start.json()
  expect(started.target_rows).toBe(2)

  const done = await waitForTerminal(v1, `/api/v1/http-runs/${started.run_id}`)
  expect(done.status).toBe('completed')
  expect(done.total_rows).toBe(2)
  expect(done.target_row_count).toBe(2)

  // Only the targeted rows were touched; the middle row has NO master cell.
  const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows
  expect(rows[0].data.Sub).toContain('✅')
  expect(rows[2].data.Sub).toContain('✅')
  expect(rows[1].data.Sub ?? '').toBe('')
  const results = await (await v1.get(`/api/v1/http-runs/${started.run_id}/results`)).json()
  expect(results.results).toHaveLength(2)

  // Unknown row id → explicit 400, not a silent partial run.
  const bad = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: httpConfig(JSON_URL, 'T3'), target_row_ids: ['row_nope'] },
  })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toContain('Unknown row id')

  await v1.dispose(); await api.dispose()
})

test('v1 run control: pause → resume → cancel with strict codes', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 30) // val = v0..v29 → 30 distinct (404ing) URLs, no cache hits
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e v1 run'))

  const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: httpConfig('https://jsonplaceholder.typicode.com/todos/{{val}}', 'Slow') },
  })
  expect(start.status()).toBe(202)
  const runId = (await start.json()).run_id

  const paused = await v1.post(`/api/v1/http-runs/${runId}/pause`)
  expect(paused.status()).toBe(200)
  expect((await paused.json()).status).toBe('paused')

  const resumed = await v1.post(`/api/v1/http-runs/${runId}/resume`)
  expect(resumed.status()).toBe(200)

  // Resume of a non-paused run → 409 (strict, unlike the UI's polite 200s).
  const notPaused = await v1.post(`/api/v1/http-runs/${runId}/resume`)
  expect(notPaused.status()).toBe(409)

  const cancelled = await v1.post(`/api/v1/http-runs/${runId}/cancel`)
  expect(cancelled.status()).toBe(200)
  expect((await cancelled.json()).status).toBe('cancelled')

  // Terminal run: pause/cancel → 409; unknown id → 404.
  expect((await v1.post(`/api/v1/http-runs/${runId}/pause`)).status()).toBe(409)
  expect((await v1.post(`/api/v1/http-runs/${runId}/cancel`)).status()).toBe(409)
  expect((await v1.get('/api/v1/http-runs/no-such-run')).status()).toBe(404)

  await v1.dispose(); await api.dispose()
})

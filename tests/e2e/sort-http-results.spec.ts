import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { makeToken, bearer, httpConfig, waitForTerminal } from './api-v1-run-helpers'

// Audit finding #2 (sort crash): the sort's http_results row_index remap was a
// single-statement UPDATE that trips the migration-028 UNIQUE(run_id,row_index)
// mid-statement, so a descending sort of any sheet with completed HTTP results
// 500'd and stayed broken. This drives the exact repro: enrich rows over HTTP,
// then sort descending, and asserts the sort succeeds and data is preserved.

test('sort descending works on a sheet that has completed HTTP enrichment results', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 4) // val = v0..v3
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e sort http'))

  // Enrich all rows so http_results rows exist under one run_id (0..3).
  const run = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: {
      config: httpConfig('https://jsonplaceholder.typicode.com/todos/1', 'Title'),
      master_column_name: 'Lookup',
    },
  })
  expect(run.status()).toBe(202)
  const done = await waitForTerminal(v1, `/api/v1/http-runs/${(await run.json()).run_id}`)
  expect(done.status).toBe('completed')

  // The bug: this sort threw UNIQUE constraint failed → 500. It must now 200.
  const sort = await api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'desc' } })
  expect(sort.status(), `sort failed: ${await sort.text()}`).toBe(200)

  // Rows are physically reordered v3..v0 and every row kept its enrichment.
  const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows
  expect(rows.map((r: any) => r.data.val)).toEqual(['v3', 'v2', 'v1', 'v0'])
  for (const r of rows) {
    expect(r.data.Title).toContain('delectus')
    expect(r.data.Lookup).toContain('✅')
  }

  // A second sort (ascending) still works — the remap left no corrupt state.
  const sort2 = await api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'asc' } })
  expect(sort2.status()).toBe(200)
  const rows2 = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows
  expect(rows2.map((r: any) => r.data.val)).toEqual(['v0', 'v1', 'v2', 'v3'])

  await v1.dispose(); await api.dispose()
})

import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet } from './helpers'

// P2-5 regression: the UI "Run Selected Rows" rerun routes (/api/ai/rerun,
// /api/http/rerun) target by row_index, so a sort/CSV-replace elsewhere between
// selection and the request re-means every index. An OPTIONAL row_generation
// fence must 409 when the client's generation is stale, while an omitted or
// matching generation passes through. Fence runs before the run lookup, so we
// can assert it independently of an actual run existing.

test.describe.configure({ mode: 'serial' })

async function currentGeneration(api: any, sheetId: string): Promise<number> {
  return (await getSheet(api, sheetId)).sheet.row_generation ?? 0
}

test('AI rerun: stale rowGeneration 409s; matching/omitted pass the fence', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 4) // v0..v3

  const gen0 = await currentGeneration(api, sheetId)

  // Sort bumps row_generation (physical reorder re-means every index).
  const sort = await api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'desc' } })
  expect(sort.ok()).toBeTruthy()
  const gen1 = await currentGeneration(api, sheetId)
  expect(gen1).not.toBe(gen0)

  // STALE generation + a rowIndices selection → 409 before any run lookup.
  const stale = await api.post('/api/ai/rerun', {
    data: { sheetId, baseColumnName: 'val', rowIndices: [0, 1], rowGeneration: gen0 },
  })
  expect(stale.status()).toBe(409)
  expect((await stale.json()).error).toMatch(/reordered elsewhere/i)

  // MATCHING generation → passes the fence; then 404 (no AI run on 'val'), NOT 409.
  const fresh = await api.post('/api/ai/rerun', {
    data: { sheetId, baseColumnName: 'val', rowIndices: [0, 1], rowGeneration: gen1 },
  })
  expect(fresh.status()).toBe(404)

  // OMITTED generation → fence skipped (back-compat); also 404, not 409.
  const omitted = await api.post('/api/ai/rerun', {
    data: { sheetId, baseColumnName: 'val', rowIndices: [0, 1] },
  })
  expect(omitted.status()).toBe(404)

  // No rowIndices (full rerun) with a stale generation → fence not applied.
  const fullRun = await api.post('/api/ai/rerun', {
    data: { sheetId, baseColumnName: 'val', rowGeneration: gen0 },
  })
  expect(fullRun.status()).toBe(404) // 404 no-run, not 409
})

test('HTTP rerun: stale rowGeneration 409s', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 4)

  const gen0 = await currentGeneration(api, sheetId)
  const sort = await api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'desc' } })
  expect(sort.ok()).toBeTruthy()

  const stale = await api.post('/api/http/rerun', {
    data: { sheetId, masterColumnName: 'val', rowIndices: [0, 1], rowGeneration: gen0 },
  })
  expect(stale.status()).toBe(409)
  expect((await stale.json()).error).toMatch(/reordered elsewhere/i)

  // Matching generation passes the fence → 404 (no HTTP run on 'val').
  const gen1 = await currentGeneration(api, sheetId)
  const fresh = await api.post('/api/http/rerun', {
    data: { sheetId, masterColumnName: 'val', rowIndices: [0, 1], rowGeneration: gen1 },
  })
  expect(fresh.status()).toBe(404)
})

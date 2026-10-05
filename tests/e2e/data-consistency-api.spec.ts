import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet } from './helpers'

// API-level E2E coverage for the data-consistency / state-sync server fixes
// (H3 row_generation fence + upsert no-resurrect + physical-sort correctness).
// Browser-driven coverage lives in data-consistency-ui.spec.ts.
// Cookie-based auth + shared sheet seeding live in ./helpers.

// ---------------------------------------------------------------------------
// H3 — row_generation fence (the headline server-side change)
// ---------------------------------------------------------------------------
test.describe('H3: row_generation fence', () => {
  test('a write with a stale generation after a sort is rejected with 409', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 5)

    const before = await getSheet(api, sheetId)
    const staleGen = before.sheet.row_generation
    expect(typeof staleGen).toBe('number')

    // Sort physically reindexes rows and bumps row_generation.
    const sort = await api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'desc' } })
    expect(sort.ok()).toBeTruthy()

    const after = await getSheet(api, sheetId)
    expect(after.sheet.row_generation).toBe(staleGen + 1)

    // A write echoing the PRE-sort generation must be fenced.
    const stalePut = await api.put(`/api/sheets/${sheetId}/data`, {
      data: { updates: [{ rowIndex: 0, columnName: 'val', value: 'STALE' }], rowGeneration: staleGen },
    })
    expect(stalePut.status()).toBe(409)

    // A write with the CURRENT generation succeeds.
    const freshPut = await api.put(`/api/sheets/${sheetId}/data`, {
      data: { updates: [{ rowIndex: 0, columnName: 'val', value: 'FRESH' }], rowGeneration: staleGen + 1 },
    })
    expect(freshPut.ok()).toBeTruthy()

    // A write with NO generation (legacy client) is NOT fenced — backwards compat.
    const noGenPut = await api.put(`/api/sheets/${sheetId}/data`, {
      data: { updates: [{ rowIndex: 1, columnName: 'val', value: 'NOGEN' }] },
    })
    expect(noGenPut.ok()).toBeTruthy()

    await api.dispose()
  })

  test('bulk-delete with a stale generation after a sort is rejected with 409', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 5)
    const staleGen = (await getSheet(api, sheetId)).sheet.row_generation

    await api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'asc' } })

    const staleDel = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, {
      data: { rowIndices: [0, 1], rowGeneration: staleGen },
    })
    expect(staleDel.status()).toBe(409)

    // Rows untouched by the rejected delete.
    expect((await getSheet(api, sheetId)).data.totalRows).toBe(5)
    await api.dispose()
  })

  // Preview-commit (AI/HTTP "Add to sheet") writes in UPSERT mode so it can
  // create the new column. Bulk-delete does NOT bump row_generation, so the
  // fence above can't catch a stale preview. The upsert write must therefore
  // refuse to INSERT a row whose row_index was deleted since the preview was
  // generated — otherwise it resurrects the row holding only the new column.
  test('upsert (preview-commit) does NOT resurrect a row deleted via bulk-delete', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 5) // rows 0..4

    // Delete rows 1 and 3 — same generation, so no fence is involved.
    const gen = (await getSheet(api, sheetId)).sheet.row_generation
    const del = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, {
      data: { rowIndices: [1, 3], rowGeneration: gen },
    })
    expect(del.ok()).toBeTruthy()
    expect((await getSheet(api, sheetId)).data.totalRows).toBe(3)

    // Commit an upsert-mode write (a stale preview) that targets a NEW column
    // 'AI' across ALL the original rows — including the deleted 1 and 3.
    const commit = await api.put(`/api/sheets/${sheetId}/data`, {
      data: {
        mode: 'upsert',
        updates: [0, 1, 2, 3, 4].map((rowIndex) => ({ rowIndex, columnName: 'AI', value: `ai${rowIndex}` })),
      },
    })
    expect(commit.ok()).toBeTruthy()
    // The two deleted rows are reported as skipped, not silently dropped.
    expect((await commit.json()).skipped).toBe(2)

    const after = await getSheet(api, sheetId)
    // No resurrection: still 3 rows, and the deleted indices stay gone.
    expect(after.data.totalRows).toBe(3)
    expect(after.data.rows.find((r: any) => r.rowIndex === 1)).toBeUndefined()
    expect(after.data.rows.find((r: any) => r.rowIndex === 3)).toBeUndefined()
    // The surviving rows DID get the new column value (upsert still writes them).
    expect(after.data.rows.find((r: any) => r.rowIndex === 0).data.AI).toBe('ai0')
    expect(after.data.rows.find((r: any) => r.rowIndex === 2).data.AI).toBe('ai2')
    // The new column is registered (it had ≥1 surviving row).
    expect(after.data.columns).toContain('AI')

    await api.dispose()
  })

  test('normal edits do NOT bump row_generation (no spurious 409s)', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 3)
    const gen = (await getSheet(api, sheetId)).sheet.row_generation
    // Several edits + an add-row; generation must stay put.
    await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [{ rowIndex: 0, columnName: 'val', value: 'x' }], rowGeneration: gen } })
    await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: 1 } })
    expect((await getSheet(api, sheetId)).sheet.row_generation).toBe(gen)
    await api.dispose()
  })
})

// ---------------------------------------------------------------------------
// Physical sort correctness (the fence must not have broken sorting)
// ---------------------------------------------------------------------------
test('sort physically reorders rows and preserves data', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 5) // v0..v4
  await api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'desc' } })
  const after = await getSheet(api, sheetId)
  const values = after.data.rows.sort((a: any, b: any) => a.rowIndex - b.rowIndex).map((r: any) => r.data.val)
  expect(values).toEqual(['v4', 'v3', 'v2', 'v1', 'v0'])
  await api.dispose()
})

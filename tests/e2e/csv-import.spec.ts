import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet, importCsv } from './helpers'

// E2E coverage for sheets-csv-import.ts + the pure csv-import-validate.ts helper
// (parse → validate → single transactional commit). Confirms the happy paths
// (append + replace) and the validation rejections preserved across the split
// out of the old sheets-csv.ts.

test.describe('CSV import', () => {
  test('append mode adds rows + reports new columns', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 2) // 'val' = v0, v1

    const res = await importCsv(api, sheetId, 'val,extra\nx,1\ny,2\n')
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.rowsImported).toBe(2)
    expect(body.startingRow).toBe(2) // appended after the 2 seeded rows
    expect(body.newColumns).toEqual(['extra']) // 'val' already existed

    const fresh = await getSheet(api, sheetId)
    expect(fresh.data.totalRows).toBe(4)
    const byIndex = (i: number) => fresh.data.rows.find((r: any) => r.rowIndex === i).data
    expect(byIndex(2)).toMatchObject({ val: 'x', extra: '1' })
    expect(byIndex(3)).toMatchObject({ val: 'y', extra: '2' })
    await api.dispose()
  })

  test('replace mode clears existing rows and bumps row_generation', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 5)
    const genBefore = (await getSheet(api, sheetId)).sheet.row_generation

    const res = await importCsv(api, sheetId, 'fresh\na\nb\n', { replaceData: true })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.rowsImported).toBe(2)
    expect(body.newColumns).toEqual([]) // replace mode reports no "new" columns

    const fresh = await getSheet(api, sheetId)
    expect(fresh.data.totalRows).toBe(2) // old 5 rows gone
    // Replace rewrites row_index 0,1,2… for new logical rows → generation bumps
    // (migration 021 fence).
    expect(fresh.sheet.row_generation).toBe(genBefore + 1)
    expect(fresh.data.rows.find((r: any) => r.rowIndex === 0).data.fresh).toBe('a')
    await api.dispose()
  })

  test('a CSV header that is a reserved internal name (__rowIndex) is rejected', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1)
    const res = await importCsv(api, sheetId, '__rowIndex,ok\n1,2\n')
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/not a valid name/i)
    // Sheet untouched (parse-first / mutate-later).
    expect((await getSheet(api, sheetId)).data.totalRows).toBe(1)
    await api.dispose()
  })

  test('case-insensitive duplicate headers within the CSV are rejected', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1)
    const res = await importCsv(api, sheetId, 'Domain,domain\na,b\n')
    expect(res.status()).toBe(400)
    // Wording comes from the shared columnCollisionMessage since the collision
    // helpers were centralized; the within-CSV branch carries the plain
    // "re-upload" fix suffix (vs the existing-column branch's Replace hint).
    const err = (await res.json()).error
    expect(err).toMatch(/case-insensitive/i)
    expect(err).toMatch(/re-upload/i)
    await api.dispose()
  })

  test('byte-identical duplicate headers are rejected (not silently collapsed)', async () => {
    // csv-parser collapses "Name,Name" into one row key (last-wins), so the
    // per-row sanitize scan never sees it — the earlier column's data would
    // vanish with a success response. Detected on the raw 'headers' event now.
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1)
    const res = await importCsv(api, sheetId, 'Name,Name,Other\na,b,c\n')
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/two columns named "Name"/i)
    await api.dispose()
  })

  test('append-mode header colliding with an existing column (case-insensitively) is rejected', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1) // existing column 'val'
    const res = await importCsv(api, sheetId, 'VAL\nx\n')
    expect(res.status()).toBe(400)
    const err = (await res.json()).error
    expect(err).toMatch(/case-insensitive/i)
    expect(err).toMatch(/Replace existing data/i)
    await api.dispose()
  })

  test('append into a column an active run owns is rejected with 409', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 2)
    // Deterministic active run without external APIs: HTTP run-start inserts
    // the run row before any request fires; pausing freezes it in a guarded
    // status (same pattern as bulk-delete-run-guard.spec.ts).
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
    expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'pause' } })).ok()).toBeTruthy()

    // CSV whose header is the run's mapped output column → 409 naming it.
    const res = await importCsv(api, sheetId, 'enrich_out\nx\n')
    expect(res.status()).toBe(409)
    expect((await res.json()).lockedColumns).toEqual(['enrich_out'])

    // Cancel the run → the same append succeeds (exact-merge into the column).
    expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'cancel' } })).ok()).toBeTruthy()
    expect((await importCsv(api, sheetId, 'enrich_out\nx\n')).ok()).toBeTruthy()
    await api.dispose()
  })

  test('a non-.csv filename is rejected', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1)
    const res = await importCsv(api, sheetId, 'val\nx\n', { filename: 'data.txt' })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/only csv/i)
    await api.dispose()
  })

  test('control characters in cell values are stripped on import', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 0)
    // NUL (0x00) and form-feed (0x0C) must be stripped; surrounding text stays.
    const res = await importCsv(api, sheetId, `val\nhe\x00ll\x0Co\n`, { replaceData: true })
    expect(res.ok()).toBeTruthy()
    const fresh = await getSheet(api, sheetId)
    expect(fresh.data.rows.find((r: any) => r.rowIndex === 0).data.val).toBe('hello')
    await api.dispose()
  })
})

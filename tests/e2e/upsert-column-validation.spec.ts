import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet } from './helpers'

// P2-4 regression: PUT /:id/data upsert mode creates new columns, so it must
// enforce the same name rules as every other creation site — reserved name,
// at-least-one-alnum, and case/token collision — against BOTH existing columns
// AND other new columns in the SAME batch (the intra-batch case).

test.describe.configure({ mode: 'serial' })

async function upsert(api: any, sheetId: string, updates: any[]) {
  return api.put(`/api/sheets/${sheetId}/data`, { data: { mode: 'upsert', updates } })
}

test('upsert rejects reserved __rowIndex as a new column', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const res = await upsert(api, sheetId, [{ rowIndex: 0, columnName: '__rowIndex', value: 'x' }])
  expect(res.status()).toBe(400)
  const cols = (await getSheet(api, sheetId)).data.columns
  expect(cols).not.toContain('__rowIndex')
})

test('upsert rejects a case-variant collision with an existing column', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2) // has column "val"
  const res = await upsert(api, sheetId, [{ rowIndex: 0, columnName: 'VAL', value: 'x' }])
  expect(res.status()).toBe(400)
  expect((await res.json()).error).toMatch(/case-insensitive|already exists|same \/column token/i)
})

test('upsert rejects TWO new columns that collide with EACH OTHER in one batch', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  // Neither "# Revenue" nor "Revenue" exists yet; both normalize to /revenue.
  // The old code checked each only against existing columns, so both slipped
  // through and got created. Must now 400.
  const res = await upsert(api, sheetId, [
    { rowIndex: 0, columnName: '# Revenue', value: '10' },
    { rowIndex: 0, columnName: 'Revenue', value: '20' },
  ])
  expect(res.status()).toBe(400)
  const cols = (await getSheet(api, sheetId)).data.columns
  // Neither colliding column should have been created.
  const revenueish = cols.filter((c: string) => c.toLowerCase().includes('revenue'))
  expect(revenueish.length).toBeLessThanOrEqual(1)
})

test('upsert still ALLOWS a legitimate new column (preview-commit shape)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const res = await upsert(api, sheetId, [{ rowIndex: 0, columnName: 'Enriched (Output)', value: 'ok' }])
  expect(res.ok()).toBeTruthy()
  const cols = (await getSheet(api, sheetId)).data.columns
  expect(cols).toContain('Enriched (Output)')
})

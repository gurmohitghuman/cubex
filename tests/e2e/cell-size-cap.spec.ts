import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet } from './helpers'
import { makeToken, bearer } from './api-v1-run-helpers'

// P2-8 two-tier per-cell size cap (matches Clay: 8k basic / 200k enrichment).
// Tier is chosen by the write's `mode`: manual grid edits send mode:'update'
// (basic, DROP oversize + report); AI/HTTP preview-commits send mode:'upsert'
// (enrichment, TRUNCATE). Direct API/MCP cell writes are basic (REJECT).

const BASIC = 8000
const ENRICHMENT = 200000

test.describe.configure({ mode: 'serial' })

test('manual edit (mode:update) over 8k is DROPPED + reported, other cells still save', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2) // column "val", rows v0,v1

  // Add a second column so we can prove the non-oversize cell in the same batch
  // still persists while the oversize one is dropped.
  expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'note' } })).ok()).toBeTruthy()

  const res = await api.put(`/api/sheets/${sheetId}/data`, {
    data: {
      mode: 'update',
      updates: [
        { rowIndex: 0, columnName: 'val', value: 'x'.repeat(BASIC + 100) }, // oversize → dropped
        { rowIndex: 0, columnName: 'note', value: 'ok' },                   // fine → saved
      ],
    },
  })
  expect(res.status()).toBe(200) // NOT a 400 — the batch is not rejected
  const body = await res.json()
  expect(body.oversizeCells).toEqual([{ rowIndex: 0, columnName: 'val' }])

  const sheet = await getSheet(api, sheetId)
  const row0 = (sheet.data.rows as Array<{ rowIndex: number; data: Record<string, string> }>).find(r => r.rowIndex === 0)!
  expect(row0.data.note).toBe('ok')                 // sibling cell saved
  expect((row0.data.val ?? '').length).toBeLessThan(BASIC + 100) // oversize NOT written
})

test('preview-commit (mode:upsert) over 200k is TRUNCATED, not rejected', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)

  const big = 'y'.repeat(ENRICHMENT + 5000)
  const res = await api.put(`/api/sheets/${sheetId}/data`, {
    data: { mode: 'upsert', updates: [{ rowIndex: 0, columnName: 'Enriched (Output)', value: big }] },
  })
  expect(res.status()).toBe(200) // truncated, not rejected

  const sheet = await getSheet(api, sheetId)
  const row0 = (sheet.data.rows as Array<{ rowIndex: number; data: Record<string, string> }>).find(r => r.rowIndex === 0)!
  const cell = row0.data['Enriched (Output)']
  expect(cell.length).toBeLessThanOrEqual(ENRICHMENT) // marker counted INSIDE the cap
  expect(cell.length).toBeLessThan(big.length)        // definitely truncated
  expect(cell.endsWith('…[truncated]')).toBe(true)
})

test('v1 API cell write over 8k is REJECTED with a documented limit message', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const v1 = await bearer(await makeToken(api, ['read', 'write'], 'e2e cellcap'))

  // Append a row whose cell exceeds the basic cap → 4xx naming the limit.
  // v1 append body shape is { rows: [{ data: { col: val } }] }.
  const res = await v1.post(`/api/v1/sheets/${sheetId}/rows`, {
    data: { rows: [{ data: { val: 'z'.repeat(BASIC + 1) } }] },
  })
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(500)
  expect((await res.json()).error).toMatch(new RegExp(`${BASIC}[\\s-]*character`, 'i'))

  await v1.dispose()
})

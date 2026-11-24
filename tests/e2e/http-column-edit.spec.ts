import { test, expect, type Page } from '@playwright/test'
import { authedApi, BASE, seedSheet } from './helpers'
import { readDb, seedCsv } from './helpers-enrich'
import { clickToVisible, median } from './helpers-speed'

// An HTTP API column's Edit (PR 3b of "Change a column's setup without running it"): the column menu opens the
// HTTP dialog on the column's newest setup, its name locked. Save keeps the new setup without running; what the
// dialog has no field for (the request timeout) is kept. Save and run on all rows saves it, then reruns the column.

type Run = { setup_only: number; config: string }
const runsOf = (sheetId: string): Run[] => readDb(db => db.prepare(
  'SELECT setup_only, config FROM http_runs WHERE sheet_id = ? ORDER BY rowid').all(sheetId))
const cellsOf = (sheetId: string): string[] =>
  readDb(db => db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheetId))

async function openEdit(page: Page) {
  const header = page.locator('.ag-header-cell').filter({ hasText: 'Lookup' }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  await header.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Edit HTTP API Column/ }).click()
  await expect(page.getByText('Edit HTTP API column', { exact: true })).toBeVisible()
}

test('HTTP API column: Edit opens its setup; Save runs nothing; Save and run reruns it', async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 3)
  const made = await api.post('/api/http/run', { data: {
    sheetId, masterColumnName: 'Lookup', saveOnly: true,
    config: {
      requestConfig: { method: 'GET', url: 'https://api.example.test/one?q={{val}}', headers: { 'X-Kind': 'a' },
        timeout: 4000 },
      responseMapping: [{ jsonPath: '$.x', columnName: 'X' }], previewSize: 5, batchSize: 5, retries: 1,
    },
  } })
  expect(made.status(), await made.text()).toBe(200)
  const cells = cellsOf(sheetId)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)

  await openEdit(page)
  const url = page.getByPlaceholder('https://api.example.com/data')
  await expect(url).toHaveValue('https://api.example.test/one?q={{val}}', { timeout: 10_000 })
  await expect(page.getByPlaceholder('e.g., Email Verification, Company Lookup')).toBeDisabled()
  await expect(page.getByPlaceholder('e.g., Email Verification, Company Lookup')).toHaveValue('Lookup')
  await url.fill('https://api.example.test/two?q={{val}}')
  await page.getByTestId('http-save-setup').click()
  await expect(page.getByText('Setup saved. Nothing ran.')).toBeVisible()
  await expect(url).toHaveCount(0)
  let runs = runsOf(sheetId)
  expect(runs.map(r => r.setup_only)).toEqual([3, 3])
  const saved = JSON.parse(runs[1].config)
  expect(saved.requestConfig).toMatchObject({ url: 'https://api.example.test/two?q={{val}}', timeout: 4000,
    headers: { 'X-Kind': 'a' } })
  expect(saved.responseMapping).toEqual([{ jsonPath: '$.x', columnName: 'X' }])
  expect(cellsOf(sheetId)).toEqual(cells)

  // Save and run on all rows: saved, then the column's rerun starts on the new setup.
  await openEdit(page)
  await expect(url).toHaveValue('https://api.example.test/two?q={{val}}', { timeout: 10_000 })
  await url.fill('https://api.example.test/three?q={{val}}')
  await page.getByTestId('http-save-and-run').click()
  await expect.poll(() => runsOf(sheetId).length, { timeout: 15_000 }).toBe(4)
  runs = runsOf(sheetId)
  expect(runs.map(r => r.setup_only)).toEqual([3, 3, 3, 0])
  expect(JSON.parse(runs[3].config).requestConfig.url).toBe('https://api.example.test/three?q={{val}}')
  await expect(url).toHaveCount(0)
})

// WORKFLOW Tests step 6: what a click opens is on screen within 100 ms, its content may load after (the setup).
test('click to visible: Edit HTTP API Column opens its drawer within 100 ms on a 10,000-row sheet', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const csv = ['Name,Website', ...Array.from({ length: 10_000 }, (_, i) => `Person ${i},company${i}.example`)]
  const { tableId, sheetId } = await seedCsv(api, csv.join('\n'))
  expect((await api.post('/api/http/run', { data: {
    sheetId, masterColumnName: 'Lookup', saveOnly: true,
    config: { requestConfig: { method: 'GET', url: 'https://api.example.test/?q={{Website}}', headers: {} },
      responseMapping: [{ jsonPath: '$.x', columnName: 'X' }], previewSize: 5, batchSize: 5 },
  } })).status()).toBe(200)
  await page.setViewportSize({ width: 1440, height: 900 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  const header = page.locator('.ag-header-cell').filter({ hasText: 'Lookup' }).first()
  const item = page.getByRole('menuitem', { name: /Edit HTTP API Column/ })
  const ms: number[] = []
  for (let i = 0; i < 5; i++) {
    await header.click({ button: 'right' })
    await expect(item).toBeVisible()
    const o = await clickToVisible(page, item, '[id^="headlessui-dialog-panel"]')
    ms.push(o.ms)
    expect(o.ms - o.drawn, 'drawn off screen first').toBeLessThanOrEqual(2)
    await expect(page.getByPlaceholder('https://api.example.com/data'))
      .toHaveValue('https://api.example.test/?q={{Website}}', { timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(page.locator('[id^="headlessui-dialog-panel"]')).toHaveCount(0)
  }
  console.log(`click to visible, Edit HTTP API Column drawer, 10,000 rows: ${ms.join(', ')} ms`)
  expect(median(ms), 'median click to visible').toBeLessThan(100)
})

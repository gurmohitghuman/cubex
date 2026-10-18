import { test, expect, Page } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { Receiver } from './helpers-receiver'

// The HTTP API column dialog: retries, "Leave out empty values" and a response
// code column, run for real against a local receiver (tests/e2e/net-shim.cjs).
// Screenshots land in test-results/shots/.
const rx = new Receiver()
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/shots/${name}.png`, fullPage: true })

test.beforeAll(async () => {
  await rx.start()
  rx.on('/ui-data', { status: 200, body: '{"ok":"from the API"}' })
})
test.afterAll(async () => { await rx.stop() })

test('the HTTP API dialog: retries, leave out empty values, a response code column', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 2)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'HTTP API', exact: true }).click()
  const d = page.locator('[role="dialog"]').filter({ hasText: 'HTTP API Column' })

  await d.locator('input[placeholder="e.g., Email Verification, Company Lookup"]').fill('Lookup')
  await d.locator('input[placeholder="https://api.example.com/data"]').fill(rx.url('/ui-data?v={{val}}', 'ui'))
  await d.getByRole('button', { name: /Response Values/ }).click()
  await d.locator('input[placeholder="$.data.name"]').first().fill('$.ok')
  await d.locator('input[placeholder="extracted_field"]').first().fill('Answer')
  await d.getByTestId('http-status-code-toggle').check()
  await expect(d.getByTestId('http-status-code-name')).toHaveValue('Lookup (Code)')
  await d.getByRole('button', { name: /Run Settings/ }).click()
  await expect(d.getByText('Retry failed requests: up to 3 times')).toBeVisible()
  await expect(d.getByTestId('http-retry-post')).not.toBeChecked()
  await d.getByTestId('http-skip-empty').check()
  await expect(d.getByText('Rate Limit')).toHaveCount(0)
  await shot(page, 'http-dialog-retry-settings')

  await d.getByRole('button', { name: /Try on/ }).click()
  await expect(d.getByText(/Columns to save \(2\)/)).toBeVisible({ timeout: 20_000 })
  await d.getByRole('button', { name: 'Run on all rows' }).click()
  await expect.poll(async () => {
    const body = await (await api.get(`/api/sheets/${sheetId}?limit=10&offset=0`)).json()
    const rows = body.data.rows as Array<{ data: Record<string, string> }>
    return rows.filter(r => r.data.val).map(r => r.data['Lookup (Code)']).join(',')
  }, { timeout: 20_000 }).toBe('200,200')
  await page.keyboard.press('Escape')
  await expect(page.locator('.ag-header-cell-text', { hasText: 'Lookup (Code)' })).toBeVisible()
  await shot(page, 'http-grid-response-code')
  expect(rx.hitsOn('/ui-data').map(h => h.query.get('v')).sort()).toEqual(expect.arrayContaining(['v0', 'v1']))
})

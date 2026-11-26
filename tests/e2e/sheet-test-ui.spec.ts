import { test, expect, type Page } from '@playwright/test'
import { authedApi, seedSheet, importCsv, getSheet, BASE } from './helpers'
import { makeToken } from './api-v1-run-helpers'
import { mcpClient, call } from './helpers-mcp'
import { openMoreMenu } from './helpers-ui'

// Trying column changes on sample rows in the app at 1280px: the ⋯ menu's "Test changes on sample rows" opens a
// copy holding the first 10 rows, with its banner; a formula changed there shows in "Apply to <sheet>", which
// applies it and opens the sheet again with every row worked out anew. A test started on chosen rows shows the
// sheet read-only (a cell takes no edit) with Open the test and Discard; discarding leaves it as it was.
// Click-to-visible times are logged for the PR. Screenshots land in test-results/shots/.
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/shots/${name}.png` })
const csv = 'Name,Website\n' + Array.from({ length: 15 }, (_, i) => `name${i},site${i}.com`).join('\n') + '\n'

async function timed(page: Page, label: string, click: () => Promise<void>, visible: string): Promise<void> {
  const t0 = Date.now()
  await click()
  await expect(page.getByTestId(visible)).toBeVisible()
  console.log(`[speed] ${label}: ${Date.now() - t0} ms`)
}

test('test changes on sample rows: start, apply, and the sheet read-only while one is open', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  const client = await mcpClient(await makeToken(api, ['read', 'write', 'run'], 'sheet test ui'))
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Short', formula: '{{Name}}.slice(0, 2)' })
  const rowsOf = async (id: string) =>
    ((await getSheet(api, id)).data.rows as Array<{ data: Record<string, string> }>).map(r => r.data)
  await expect.poll(async () => (await rowsOf(sheetId))[14]?.Short).toBe('na')

  await page.setViewportSize({ width: 1280, height: 800 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}/${sheetId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await timed(page, 'Test changes on sample rows -> the copy\'s banner',
    () => openMoreMenu(page, 'Test changes on sample rows'), 'sheet-test-banner')
  const banner = page.getByTestId('sheet-test-banner')
  await expect(banner).toContainText('Test copy of')
  await expect(banner).toContainText('10 sample rows')
  await expect(page.locator('.ag-center-cols-container .ag-row')).toHaveCount(10)
  const copyId = new URL(page.url()).pathname.split('/').pop()!
  expect(copyId).not.toBe(sheetId)
  await page.waitForTimeout(300)
  await shot(page, 'sheet-test-copy')

  await call(client, 'formula_column', { sheet_id: copyId, column: 'Short', formula: '{{Name}}.slice(0, 5)' })
  await expect.poll(async () => (await rowsOf(copyId))[0]?.Short).toBe('name0')
  await timed(page, 'Apply to <sheet> -> its dialog', () => page.getByTestId('sheet-test-apply').click(),
    'apply-test-dialog')
  await expect(page.getByTestId('apply-test-message')).toContainText('Applying will set up 1 column as in the test')
  await expect(page.getByTestId('apply-test-dialog')).toContainText('Short')
  await shot(page, 'sheet-test-apply')
  await page.getByTestId('apply-test-confirm').click()
  await expect(page).toHaveURL(new RegExp(`/${sheetId}$`))
  await expect(page.getByTestId('sheet-test-banner')).toHaveCount(0)
  await expect.poll(async () => (await rowsOf(sheetId))[14]?.Short, { timeout: 20_000 }).toBe('name1')

  // Started on chosen rows (the app sends their places): the sheet shows read-only.
  const started = await api.post(`/api/sheets/${sheetId}/test`, { data: { row_indexes: [3, 5] } })
  expect(started.status(), await started.text()).toBe(201)
  expect((await rowsOf((await started.json()).test.test_sheet_id)).map(r => r.Name)).toEqual(['name3', 'name5'])
  await page.reload()
  await expect(page.getByTestId('sheet-test-banner')).toContainText('can\'t be changed until the test')
  await page.locator('.ag-row[row-index="0"] .ag-cell', { hasText: 'site0.com' }).dblclick()
  await expect(page.getByText('Add Column')).toHaveCount(0)
  await expect(page.locator('.ag-popup-editor, .ag-cell-inline-editing')).toHaveCount(0)
  await shot(page, 'sheet-test-read-only')
  await page.getByTestId('sheet-test-discard').click()
  await page.getByRole('button', { name: 'Discard test' }).last().click()
  await expect(page.getByTestId('sheet-test-banner')).toHaveCount(0, { timeout: 10_000 })
  expect((await rowsOf(sheetId)).length).toBe(15)
})

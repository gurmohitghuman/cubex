import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE } from './helpers'
import { openDataMenu } from './helpers-ui'

// In the app: a cell edit keeps U+0080-U+009F (what makes text read with the
// wrong character set repairable) on screen and in the sheet, and the CSV
// import's summary says how many cells look garbled and shows them.

const VALUES = ['C1test\u0080\u0089end', 'FraudFighterâ\u0084¢', 'CODE Ã\u0089xitos']
const firstCell = '.ag-row[row-index="0"] [col-id^="col_"] >> nth=0'

test('a cell edit keeps C1 characters', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await seedSheet(api, 1) // val: v0

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(firstCell)).toHaveText('v0', { timeout: 15_000 })
  await page.locator(firstCell).dblclick()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(VALUES[1])
  await page.keyboard.press('Enter')

  await expect.poll(async () => (await getSheet(api, sheetId)).data.rows[0].data.val, { timeout: 10_000 })
    .toBe(VALUES[1])
  expect(await page.locator(firstCell).textContent()).toBe(VALUES[1])
})

test('the import summary says how many cells look garbled and shows them', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId } = await seedSheet(api, 1)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(firstCell)).toHaveText('v0', { timeout: 15_000 })
  await openDataMenu(page, 'Import CSV')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'garbled.csv', mimeType: 'text/csv',
    buffer: Buffer.from(['Name,Note', ...VALUES.map(v => `${v},José`)].join('\n'), 'utf8'),
  })
  await page.getByRole('button', { name: 'Upload CSV' }).click()

  const summary = page.getByTestId('import-garbled-toast')
  await expect(summary).toContainText('3 cells look garbled, like text read with the wrong character set.',
    { timeout: 15_000 })
  await expect(summary).toContainText('Fix garbled characters')
  for (const v of VALUES) await expect(summary).toContainText(`Name: ${v}`)
  await expect(summary).not.toContainText('José')
})

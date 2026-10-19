import { test, expect } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { seedLeads } from './helpers-dedupe'
import { openDataMenu } from './helpers-ui'

// Auto-dedupe in the app: the Remove duplicates dialog's "As rows arrive" tab
// opens on the Email column matched as an email, turns it on and says how many
// rows already share a key; the toolbar shows it's on. A row added in the grid
// and given a key already there goes to the trash (the toast restores just it);
// the dialog counts what went and links to the trash, narrowed to them. A
// setting with phone_country keeps it when the dialog saves another keep.

// Nth data cell of a row, in rendered column order (val, Email, Website, Name).
const dataCell = (row: number, n: number) => `.ag-row[row-index="${row}"] [col-id^="col_"] >> nth=${n}`

test('auto-dedupe from the Remove duplicates dialog, a key typed into a new row', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedLeads(api)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await openDataMenu(page, 'Remove duplicates')
  await page.getByTestId('dedupe-tab-auto').click()
  await expect(page.getByTestId('auto-dedupe-column')).toHaveAttribute('data-value', 'Email')
  await expect(page.getByTestId('auto-dedupe-match')).toHaveAttribute('data-value', 'email')
  await expect(page.getByLabel('Oldest row')).toBeChecked()
  await page.getByTestId('auto-dedupe-save').click()
  await expect(page.getByText('Auto-dedupe is on')).toBeVisible()
  await expect(page.getByTestId('auto-dedupe-status'))
    .toContainText('3 rows already in the sheet share a key with an older row', { timeout: 20_000 })
  await expect(page.getByTestId('dedupe-tab-auto')).toContainText('On')
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByTestId('auto-dedupe-chip')).toBeVisible()

  const addRow = async (rows: number) => {
    await page.getByLabel('Number of rows to add').fill('1')
    await page.getByRole('button', { name: 'Add rows' }).click()
    await expect(page.getByText(`${rows} rows`)).toBeVisible()
  }
  const type = async (row: number, text: string) => {
    await page.locator(dataCell(row, 1)).dblclick()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }

  // A new row given a key already there goes; Restore puts back just it.
  await addRow(10)
  await type(9, 'PAT@beta.io')
  await expect(page.getByTestId('deleted-toast'))
    .toContainText('Auto-dedupe sent 1 row with a repeated Email to the trash', { timeout: 15_000 })
  await expect(page.getByText('9 rows')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('deleted-toast-restore').click()
  await expect(page.getByText('Restored 1 row')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('10 rows')).toBeVisible({ timeout: 15_000 })

  // Another one, left in the trash: the dialog counts it and links there.
  await addRow(11)
  await type(10, 'jo@acme.com')
  await expect(page.getByText('10 rows')).toBeVisible({ timeout: 15_000 })
  await openDataMenu(page, 'Remove duplicates')
  await page.getByTestId('dedupe-tab-auto').click()
  await expect(page.getByTestId('auto-dedupe-status')).toContainText('2 rows removed so far')
  await page.getByTestId('auto-dedupe-trash-link').click()
  await expect(page).toHaveURL(new RegExp(`/trash\\?sheet=${sheetId}&how=auto_dedupe`))
  await expect(page.getByTestId('trash-scope')).toContainText('Removed by auto-dedupe')
  await expect(page.getByText('Removed by auto-dedupe').last()).toBeVisible()
})

// A setting made over the API with phone_country: the dialog says how bare
// numbers are read, and saving another keep sends the country back.
test('auto-dedupe keeps phone_country when the dialog saves another keep', async ({ page, context }) => {
  const api = await authedApi()
  const { tableId, sheetId } = await seedLeads(api)
  expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'Phone' } })).ok()).toBeTruthy()
  expect((await api.put(`/api/sheets/${sheetId}/auto-dedupe`,
    { data: { column: 'Phone', match: 'phone', phone_country: 'GB', keep: 'oldest' } })).ok()).toBeTruthy()
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await openDataMenu(page, 'Remove duplicates')
  await page.getByTestId('dedupe-tab-auto').click()
  await expect(page.getByTestId('auto-dedupe-column')).toHaveAttribute('data-value', 'Phone')
  await expect(page.getByTestId('auto-dedupe-country')).toContainText('read as GB numbers')
  await page.getByLabel('Newest row').check()
  await page.getByTestId('auto-dedupe-save').click()
  await expect(page.getByText('Auto-dedupe saved')).toBeVisible()
  const view = (await (await api.get(`/api/sheets/${sheetId}/auto-dedupe`)).json()).autoDedupe
  expect(view).toMatchObject({ column: 'Phone', match: 'phone', phone_country: 'GB', keep: 'newest' })
})

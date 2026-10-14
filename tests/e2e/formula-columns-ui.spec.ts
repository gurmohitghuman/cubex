import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE } from './helpers'

// The app's Formula flow: "+ Add Column" offers Formula; "Insert a column"
// writes {{Name}} at the cursor; the preview shows what the formula gives;
// the new column gets its icon and values; its menu edits the formula and
// switches auto-run; and an edit to an input reaches the column on its own.

const reply = (work: string | null) => JSON.stringify({
  emails: [{ type: 'personal', value: 'me@gmail.com' }, ...(work ? [{ type: 'work', value: work }] : [])],
})
const SEED = [
  { Response: reply('ada@acme.com'), First: 'Ada' },
  { Response: reply(null), First: 'Grace' },
]

async function seedPeople(api: APIRequestContext) {
  const { tableId, sheetId } = await seedSheet(api, SEED.length)
  for (const c of ['Response', 'First']) await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: c } })
  const updates = SEED.flatMap((r, i) =>
    Object.entries(r).map(([columnName, value]) => ({ rowIndex: i, columnName, value })))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  return { tableId, sheetId }
}

const header = (page: Page, name: string) => page.locator('.ag-header-cell').filter({ hasText: name }).first()
async function openMenu(page: Page, name: string) {
  await header(page, name).locator('.ag-header-cell-text').first().click()
  await expect(page.getByRole('menu')).toBeVisible()
}
const row = (page: Page, i: number) => page.locator(`.ag-center-cols-container .ag-row[row-index="${i}"]`)
const values = async (api: APIRequestContext, sheetId: string, column: string) =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data[column] ?? '')

test('Formula from the Add Column dialog and the column menu', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedPeople(api)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /add new column/i }).click()
  await page.getByTestId('new-column-formula').click()
  const form = page.getByTestId('formula-column-form')
  await expect(form.getByTestId('formula-writer')).toBeVisible()
  await form.locator('#formula-name').fill('Work email')
  // "Insert a column" puts {{Response}} where the cursor is.
  const box = page.getByTestId('formula-text')
  await page.getByTestId('formula-insert').selectOption('Response')
  await expect(box).toHaveValue('{{Response}}')
  await box.press('End')
  await box.pressSequentially('?.emails?.find(e => e.type == "work")?.value')
  await expect(page.getByTestId('formula-preview')).toContainText('ada@acme.com', { timeout: 10_000 })
  await expect(page.getByTestId('formula-autorun')).toBeChecked()
  await page.getByTestId('formula-submit').click()

  await expect(header(page, 'Work email')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('formula-icon')).toHaveCount(1)
  await expect(row(page, 0)).toContainText('ada@acme.com', { timeout: 15_000 })
  expect(await values(api, sheetId, 'Work email')).toEqual(['ada@acme.com', ''])

  // Its menu: edit the formula, work it out again, auto-run (on by default).
  await openMenu(page, 'Work email')
  const menu = page.getByRole('menu')
  for (const t of ['Formula Actions', 'Edit formula', 'Work out every row again', 'Turn Off Auto-run']) {
    await expect(menu).toContainText(t)
  }
  await page.getByRole('menuitem', { name: /Edit formula/ }).click()
  await expect(page.getByRole('dialog')).toContainText('Edit formula')
  await expect(box).toHaveValue('{{Response}}?.emails?.find(e => e.type == "work")?.value')
  await box.fill('{{Response}}?.emails?.map(e => e.value).join(", ")')
  await expect(page.getByTestId('formula-preview')).toContainText('me@gmail.com, ada@acme.com', { timeout: 10_000 })
  await page.getByTestId('formula-submit').click()
  await expect.poll(() => values(api, sheetId, 'Work email'), { timeout: 15_000 })
    .toEqual(['me@gmail.com, ada@acme.com', 'me@gmail.com'])

  // An edit to the input reaches the formula column on its own (auto-run follows it).
  const edit = [{ rowIndex: 1, columnName: 'Response', value: reply('grace@navy.mil') }]
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: edit } })).ok()).toBeTruthy()
  await expect.poll(() => values(api, sheetId, 'Work email'), { timeout: 15_000 })
    .toEqual(['me@gmail.com, ada@acme.com', 'me@gmail.com, grace@navy.mil'])
  await expect(row(page, 1)).toContainText('grace@navy.mil', { timeout: 30_000 })

  // Auto-run off from the menu.
  await openMenu(page, 'Work email')
  await page.getByRole('menuitem', { name: /Turn Off Auto-run/ }).click()
  await expect.poll(async () => (await getSheet(api, sheetId)).data.formulaColumns['Work email'].autoRun,
    { timeout: 10_000 }).toBe(false)
})

test('A formula the sheet refuses says why in the dialog', async ({ page, context }) => {
  const api = await authedApi()
  const { tableId } = await seedPeople(api)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /add new column/i }).click()
  await page.getByTestId('new-column-formula').click()
  await page.getByTestId('formula-text').fill('{{Frist}}.toUpperCase()')
  await expect(page.getByTestId('formula-preview-error')).toContainText('Did you mean "First"', { timeout: 10_000 })
  await page.getByTestId('formula-text').fill('{{First}} +* 2')
  await expect(page.getByTestId('formula-preview-error')).toContainText('SyntaxError', { timeout: 10_000 })
})

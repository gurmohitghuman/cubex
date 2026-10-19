import { test, expect } from '@playwright/test'
import os from 'node:os'
import { authedApi, BASE, getSheet, seedSheet } from './helpers'

// The trash in the app: rows deleted in the grid come back from the toast's
// Restore at their old places; the Trash page lists a deleted sheet and a
// batch, finds rows inside a batch and restores the picked one, restores the
// sheet, and deletes a batch for good; the sheet's History panel lists it all
// with who did it; Settings sets the days. Screenshots go to SHOT_DIR.
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()
const DATA_CELL = (row: number) => `.ag-row[row-index="${row}"] [col-id^="col_"]`
const SEL_CHECKBOX = (row: number) => `.ag-row[row-index="${row}"] [col-id="ag-Grid-SelectionColumn"] input`
const values = async (api: Awaited<ReturnType<typeof authedApi>>, sheetId: string) =>
  ((await getSheet(api, sheetId)).data.rows as Array<{ rowIndex: number; data: { val: string } }>)
    .map(r => `${r.rowIndex}:${r.data.val}`)

test('grid delete → Restore in the toast; Trash page restores picked rows and a sheet; History lists it',
  async ({ page, context }) => {
    test.setTimeout(120_000)
    const api = await authedApi()
    await context.addCookies((await api.storageState()).cookies)
    const { tableId, sheetId } = await seedSheet(api, 6)
    const before = await values(api, sheetId)

    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v0', { timeout: 15_000 })
    await page.locator(SEL_CHECKBOX(1)).check()
    await page.locator(SEL_CHECKBOX(3)).check()
    await page.getByRole('button', { name: /delete \(2\)/i }).click()
    await expect(page.getByText(/They go to the trash, where you can restore them/)).toBeVisible()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const toast = page.getByTestId('deleted-toast')
    await expect(toast).toContainText('2 rows deleted')
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOT_DIR}/trash-01-deleted-toast.png` })
    await toast.getByTestId('deleted-toast-restore').click()
    await expect(page.getByText(/Restored 2 rows to their old places/)).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => values(api, sheetId)).toEqual(before)
    await expect(page.locator(DATA_CELL(1)).first()).toHaveText('v1', { timeout: 15_000 })

    // Delete two rows again (the API this time), and the sheet's sibling tab.
    const rows = (await getSheet(api, sheetId)).data.rows as Array<{ rowIndex: number }>
    const del = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, {
      data: { rowIndices: [rows[2].rowIndex, rows[5].rowIndex], rowGeneration: 0 },
    })
    expect(del.ok(), await del.text()).toBeTruthy()
    const batchId = (await del.json()).trash.id as number
    const extra = await (await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Leads Q3' } })).json()
    const gone = await (await api.delete(`/api/tables/${tableId}/sheets/${extra.sheet.id}`)).json()

    await page.goto(`${BASE}/dashboard`)
    await page.getByTestId('open-trash').click()
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible()
    const batch = page.locator(`[data-trash-id="${batchId}"]`)
    await expect(batch).toContainText('2 rows from "Sheet1"')
    await expect(page.locator(`[data-trash-id="${gone.trash.id}"]`)).toContainText('Sheet "Leads Q3"')
    await page.getByTestId('trash-search').fill('Leads Q3')
    await expect(page.getByTestId('trash-item')).toHaveCount(1)
    await page.screenshot({ path: `${SHOT_DIR}/trash-02-search.png` })
    await page.getByTestId('trash-search').fill('')

    // Inside the batch: find v5, restore only it.
    await batch.getByTestId('trash-more').click()
    await page.getByTestId('trash-look').click()
    await page.getByTestId('trash-rows-column').selectOption('val')
    await page.getByTestId('trash-rows-search').fill('v5')
    const found = page.getByTestId('trash-rows').locator('tbody tr')
    await expect(found).toHaveCount(1)
    await found.first().locator('input[type="checkbox"]').check()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOT_DIR}/trash-03-look-inside.png` })
    await page.getByTestId('trash-rows-restore').click()
    await expect(page.getByText(/Restored 1 row to their old places/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(batch).toContainText('1 row from "Sheet1"')

    // The sheet comes back as a tab.
    await page.locator(`[data-trash-id="${gone.trash.id}"]`).getByTestId('trash-restore').click()
    await expect(page.getByText('Restored the sheet "Leads Q3"')).toBeVisible()
    await expect(page.locator(`[data-trash-id="${gone.trash.id}"]`)).toHaveCount(0)

    // Delete the rest of the batch for good.
    await batch.getByTestId('trash-more').click()
    await page.getByTestId('trash-delete').click()
    await page.getByRole('button', { name: 'Delete for good' }).click()
    await expect(batch).toHaveCount(0, { timeout: 15_000 })
    await page.screenshot({ path: `${SHOT_DIR}/trash-04-after.png` })

    // History.
    await page.goto(`${BASE}/table/${tableId}/${sheetId}`)
    await page.getByTestId('sheet-history').click()
    const lines = page.getByTestId('history-line')
    await expect(lines.first()).toContainText('Restored 1 row to their old places')
    await expect(page.getByTestId('history-list')).toContainText('Deleted 2 rows')
    await expect(page.getByTestId('history-list')).toContainText('the app')
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOT_DIR}/trash-05-history.png` })
  })

test('Settings sets how long the trash keeps things; lowering it to 0 empties it', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { sheetId } = await seedSheet(api, 3)
  const del = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, { data: { rowIndices: [0], rowGeneration: 0 } })
  const batchId = (await del.json()).trash.id as number
  try {
    await page.goto(`${BASE}/settings/account`)
    const card = page.getByTestId('trash-days')
    await expect(card).toContainText('Keep deleted items: 30 days')
    await card.getByRole('button', { name: 'Change' }).click()
    await card.getByLabel('Days to keep deleted items').fill('0')
    await card.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText(/Everything in the trash now is deleted for good/)).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOT_DIR}/trash-06-settings-confirm.png` })
    await page.getByRole('button', { name: 'Save' }).last().click()
    await expect(card).toContainText('no, delete them at once')
    await expect.poll(async () => (await (await api.get('/api/trash')).json()).items
      .some((i: { id: number }) => i.id === batchId), { timeout: 15_000 }).toBe(false)
    const again = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`, {
      data: { rowIndices: [2], rowGeneration: 0 },
    })
    expect((await again.json()).trash).toBeNull()
  } finally {
    await api.put('/api/settings/trash', { data: { days: 30 } })
  }
})

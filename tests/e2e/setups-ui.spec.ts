import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'

// The app's setups: "Save as setup…" on a filled column ticks it and the
// filled columns it reads, shows the order and what a sheet needs, and saves;
// Settings → Setups lists it to rename, export as a file, delete, and import
// the file back.

async function seedChain(api: APIRequestContext) {
  const { tableId, sheetId } = await seedSheet(api, 2)
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'Website' } })
  const updates = ['acme.com', 'navy.mil'].map((value, rowIndex) => ({ rowIndex, columnName: 'Website', value }))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  for (const [column, formula] of [['Domain', '{{Website}}?.split(".")[0]'], ['Label', '{{Domain}} + "!"']]) {
    const res = await api.post(`/api/sheets/${sheetId}/formula-columns`, { data: { column, formula } })
    expect(res.ok(), await res.text()).toBeTruthy()
  }
  return { tableId, sheetId }
}

const header = (page: Page, name: string) => page.locator('.ag-header-cell').filter({ hasText: name }).first()

test('Save as setup from a column, then manage it in Settings', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  const { tableId } = await seedChain(api)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(header(page, 'Label')).toBeVisible({ timeout: 15_000 })

  // The column menu opens the dialog with the column and what it reads ticked.
  await header(page, 'Label').locator('.ag-header-cell-text').first().click()
  await page.getByRole('menuitem', { name: /Save as setup/ }).click()
  const form = page.getByTestId('save-setup-form')
  await expect(form.getByRole('checkbox', { name: 'Label' })).toBeChecked()
  await expect(form.getByRole('checkbox', { name: 'Domain' })).toBeChecked()
  const plan = page.getByTestId('setup-plan')
  await expect(plan).toContainText('Domain')
  await expect(page.getByTestId('setup-plan-inputs')).toHaveText('Website')
  await expect(page.getByTestId('setup-save')).toBeDisabled()

  // Unticking Domain makes it something the sheet needs instead.
  await form.getByRole('checkbox', { name: 'Domain' }).uncheck()
  await expect(page.getByTestId('setup-plan-inputs')).toHaveText('Domain')
  await form.getByRole('checkbox', { name: 'Domain' }).check()
  await expect(page.getByTestId('setup-plan-inputs')).toHaveText('Website')

  await page.getByTestId('setup-name').fill('Domain label')
  await page.getByTestId('setup-save').click()
  await expect(page.getByText('Saved the setup "Domain label"')).toBeVisible()
  await expect(form).toBeHidden()

  // The header's Setups menu leads to Settings → Setups.
  await page.getByTestId('setups-menu').click()
  await page.getByRole('menuitem', { name: 'Manage setups' }).click()
  await expect(page).toHaveURL(/\/settings\/setups$/)
  const card = page.getByTestId('setup-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Domain label')
  await expect(card).toContainText('1. Domain')
  await expect(card).toContainText('2. Label')
  await expect(card).toContainText('Needs Website')

  await page.getByRole('button', { name: 'Edit Domain label' }).click()
  await page.getByTestId('setup-edit-name').fill('Domain tag')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(card).toContainText('Domain tag')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Domain tag' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('domain-tag.cubex-setup.json')
  const file = await download.path()

  await page.getByRole('button', { name: 'Delete Domain tag' }).click()
  await page.getByRole('button', { name: 'Delete setup' }).click()
  await expect(page.getByText('No setups yet')).toBeVisible()

  await page.getByTestId('setup-import-file').setInputFiles(file)
  await expect(page.getByText('Imported the setup "Domain tag"')).toBeVisible()
  await expect(card).toContainText('Domain tag')
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
})

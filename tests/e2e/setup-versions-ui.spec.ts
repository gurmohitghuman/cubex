import { test, expect, type Page } from '@playwright/test'
import { authedApi, seedSheet, importCsv, BASE } from './helpers'
import { makeToken } from './api-v1-run-helpers'
import { mcpClient, call } from './helpers-mcp'
import { openMoreMenu } from './helpers-ui'

// Setup versions in the app at 1280px: a sheet tab's menu opens them; a
// version saved, then the sheet changed over the API (a formula column
// deleted, a description edited); comparing shows both, restoring brings the
// column back and History says so; the Setups menu opens them too, where a
// version is renamed and one deleted. Screenshots land in test-results/shots/.
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/shots/${name}.png` })

test('save, compare and restore a setup version from the sheet menu', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, 'Name,Website\nAda,acme.com\nBo,navy.mil\n', { replaceData: true })).ok())
    .toBeTruthy()
  const client = await mcpClient(await makeToken(api, ['read', 'write', 'run'], 'setup versions ui'))
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  await call(client, 'set_description', { sheet_id: sheetId, column: 'Name', description: 'Who signed up' })

  await page.setViewportSize({ width: 1280, height: 800 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await page.locator('[aria-label^="Sheet options for"]').first().click()
  await page.getByTestId('sheet-setup-versions').click()
  const dialog = page.getByTestId('setup-versions-dialog')
  await expect(dialog).toContainText('Cell values are never saved or changed.')
  // Focus is in the name box already: typing names the version.
  await expect(page.getByTestId('setup-versions-empty')).toBeVisible()
  await expect(page.getByTestId('setup-version-name')).toBeFocused()
  await page.keyboard.type('Before the cleanup')
  await page.getByTestId('setup-version-save').click()
  await expect(page.getByTestId('setup-version-row')).toHaveCount(1)
  await expect(page.getByTestId('setup-version-row')).toContainText('3 columns, 1 fills itself')
  await page.waitForTimeout(300)
  await shot(page, 'setup-versions-list')

  // The sheet changes while the dialog is open.
  await call(client, 'delete_column', { sheet_id: sheetId, column: 'Domain' })
  await call(client, 'set_description', { sheet_id: sheetId, column: 'Name', description: 'Changed' })
  await page.getByTestId('setup-version-compare').click()
  await expect(page.getByTestId('setup-version-section-add_back')).toContainText('Domain')
  await expect(page.getByTestId('setup-version-section-restore')).toContainText('Name')
  await expect(page.getByTestId('setup-version-section-restore')).toContainText('Who signed up')
  await expect(dialog).toContainText('Nothing runs, nothing is billed, and no cell changes')
  await page.waitForTimeout(300)
  await shot(page, 'setup-versions-compare')

  await dialog.getByRole('button', { name: 'Restore this version' }).click()
  await expect(page.getByTestId('setup-version-message')).toContainText('Restored. 1 column added back (empty)')
  await expect(dialog).toContainText('Restored: Before the cleanup')
  await page.waitForTimeout(300)
  await shot(page, 'setup-versions-done')
  await page.getByTestId('setup-versions-close').click()
  await expect(page.locator('.ag-header-cell').filter({ hasText: 'Domain' })).toBeVisible({ timeout: 10_000 })

  await openMoreMenu(page, 'History')
  await expect(page.getByText('Restored the setup version "Before the cleanup"')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Saved the setup version "Before the cleanup"')).toBeVisible()
  await page.waitForTimeout(300)
  await shot(page, 'setup-versions-history')
  await page.keyboard.press('Escape')

  // The Setups menu opens them too: the restore kept the setup it replaced.
  await page.getByTestId('more-menu').click()
  await page.getByTestId('setups-menu-versions').click()
  await expect(page.getByTestId('setup-version-row')).toHaveCount(2)
  await expect(page.getByTestId('setup-version-row').first()).toContainText('Automatic')
  await expect(page.getByTestId('setup-version-row').first()).toContainText('Before restoring: Before the cleanup')
  await page.getByTestId('setup-version-rename').nth(1).click()
  await page.getByTestId('setup-version-rename-input').fill('Clean start')
  await page.getByTestId('setup-version-rename-input').press('Enter')
  await expect(page.getByTestId('setup-version-row').nth(1)).toContainText('Clean start')
  await page.getByTestId('setup-version-delete').first().click()
  await expect(dialog).toContainText('Delete?')
  await page.waitForTimeout(200)
  await shot(page, 'setup-versions-delete')
  await page.getByTestId('setup-version-delete-yes').click()
  await expect(page.getByTestId('setup-version-row')).toHaveCount(1)
  await expect(page.getByTestId('setup-version-row')).toContainText('Clean start')

  // The sheet is set up as that version is: nothing to restore, and no button to.
  await page.getByTestId('setup-version-compare').click()
  await expect(page.getByTestId('setup-version-message')).toContainText('Nothing to restore')
  await expect(page.getByTestId('setup-version-restore')).toHaveCount(0)
  await page.getByTestId('setup-versions-back').click()

  // A version deleted elsewhere: comparing it says so, and the list shows what's there.
  const gone = await call(client, 'manage_setup_version', { sheet_id: sheetId, action: 'save', name: 'Gone soon' })
  await page.getByTestId('setup-versions-close').click()
  await page.getByTestId('more-menu').click()
  await page.getByTestId('setups-menu-versions').click()
  await expect(page.getByTestId('setup-version-row')).toHaveCount(2)
  await call(client, 'manage_setup_version', { sheet_id: sheetId, action: 'delete', version_id: gone.version.id })
  await page.getByTestId('setup-version-compare').first().click()
  await expect(page.getByTestId('setup-versions-error')).toContainText('not found')
  await expect(page.getByTestId('setup-version-row')).toHaveCount(1)
})

test('a long AI prompt changed in the middle: the comparison marks what changed', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, 'Name\nAda\n', { replaceData: true })).ok()).toBeTruthy()
  const client = await mcpClient(await makeToken(api, ['read', 'write', 'run'], 'setup versions ui ai'))
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
  const prompt = (middle: string) => `Read /name. ${words(60)} ${middle} ${words(60)} Answer yes or no.`
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    for (const [i, middle] of ['Prefer small companies.', 'Prefer large companies in Europe.'].entries()) {
      const run = await call(client, 'run_ai_column', { sheet_id: sheetId, column_name: 'Fit',
        prompt: prompt(middle), model: 'deepseek/deepseek-v4-flash' })
      await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'ai', run_id: run.run_id }))
        .status, { timeout: 60_000 }).toMatch(/completed|failed/)
      if (i === 0) await call(client, 'manage_setup_version', { sheet_id: sheetId, action: 'save', name: 'Small' })
    }
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.locator('[aria-label^="Sheet options for"]').first().click()
  await page.getByTestId('sheet-setup-versions').click()
  await page.getByTestId('setup-version-compare').click()
  const section = page.getByTestId('setup-version-section-restore')
  await expect(section.locator('mark').first()).toHaveText('small companies.')
  await expect(section.locator('mark').nth(1)).toHaveText('large companies in Europe.')
  await expect(section.getByRole('button', { name: 'Show all' }).first()).toBeVisible()
  await expect(section).toContainText('Force run all rows')
  await page.waitForTimeout(300)
  await shot(page, 'setup-versions-ai-compare')
  await section.getByRole('button', { name: 'Show all' }).first().click()
  await expect(section).toContainText('word59')
  await shot(page, 'setup-versions-ai-compare-all')
})

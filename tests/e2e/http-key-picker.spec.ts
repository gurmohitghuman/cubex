import { test, expect, Page } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { openColumnType } from './helpers-ui'

// The HTTP API column dialog's key picker: "Save for next time as" takes a
// name of at most API_KEY_NAME_MAX (200) characters, the longest a saved key
// can be saved with, so a longer one can't be typed only for the save to fail.

const drawer = (page: Page) => page.locator('[role="dialog"]').filter({ hasText: 'HTTP API Column' })

test('"Save for next time as" stops at 200 characters', async ({ page, context }) => {
  const api = await authedApi()
  const { tableId } = await seedSheet(api, 1)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await openColumnType(page, 'HTTP API')
  const d = drawer(page)

  await d.getByPlaceholder('Paste your API key here').fill('sk-picker-e2e-0123456789')
  await d.getByText('Save for next time as').click()
  const name = d.getByPlaceholder('e.g. Apollo')
  await expect(name).toBeEnabled()
  await expect(name).toHaveAttribute('maxlength', '200')
  await name.pressSequentially('k'.repeat(205))
  await expect(name).toHaveValue('k'.repeat(200))
  await api.dispose()
})

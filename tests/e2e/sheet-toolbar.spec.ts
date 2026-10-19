import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { openColumnType, openDataMenu } from './helpers-ui'

// The sheet header: AI Column and the column types beside it, the Data and ⋯ menus. Each
// entry opens its dialog or drawer; a menu closed without a pick gives focus back to its
// button; Escape in a dropdown closes only the dropdown; at 900px the header stays one line.

test('sheet toolbar menus open their dialogs and stay on one line', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId } = await seedSheet(api, 3)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  // The built-in kinds open the Add Column dialog on their own choice (a lookup with no
  // other sheet says to add one first, so its form isn't there yet).
  for (const [kind, choice] of [['Clean data', 'clean'], ['Formula', 'formula'], ['Lookup', 'lookup']]) {
    await openColumnType(page, kind)
    await expect(page.getByTestId(`new-column-${choice}`)).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByTestId(`new-column-${choice}`)).toBeHidden()
  }

  // Escape in a dropdown closes the dropdown, not the dialog around it.
  await openColumnType(page, 'Clean data')
  await page.waitForFunction(() => document.getAnimations().length === 0) // the dialog has opened
  await page.locator('#clean-cleaner').click()
  await expect(page.getByRole('listbox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toBeHidden()
  await expect(page.getByTestId('clean-column-form')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  // Data, Webhook: its drawer.
  await openDataMenu(page, 'Webhook')
  const webhook = page.getByRole('heading', { name: 'Webhook', exact: true })
  await expect(webhook).toBeVisible()
  await page.waitForFunction(() => document.getAnimations().length === 0) // the drawer has opened
  await page.keyboard.press('Escape')
  await expect(webhook).toBeHidden()

  // A menu closed without a pick: focus is back on its button.
  await page.getByTestId('data-menu').click()
  await expect(page.getByRole('menuitem', { name: /^Import CSV/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('data-menu')).toBeFocused()

  // Narrow: one line, nothing wrapped (the header row keeps its height).
  await page.setViewportSize({ width: 900, height: 720 })
  const header = await page.locator('header').first().boundingBox()
  expect(header!.height).toBeLessThanOrEqual(58)
  for (const id of ['data-menu', 'more-menu', 'column-types-menu']) await expect(page.getByTestId(id)).toBeVisible()
})

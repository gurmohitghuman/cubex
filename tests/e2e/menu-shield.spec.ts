import { test, expect, type Locator, type Page } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'

// Over 200 lines: what a modal menu gave and each menu still does, on the sheet and the dashboard, read together.
// Menus are not modal (client components/ui/menu-shield.tsx) and keep what a modal menu gave: a click or a tap
// outside closes the menu and does nothing else (the grid under it doesn't select a cell, another column's menu
// doesn't open, a button doesn't act), the wheel doesn't scroll the grid behind it, Escape closes it, and focus goes
// back to the menu's button; the keyboard opens, moves through and picks from a menu, and Tab in a menu's filter
// stays in it; a drawer an entry opens takes focus and gives it back to that button when it closes; and a second
// menu opens on the first click. One thing is new: Tab on an entry closes the menu (a modal menu kept Tab in).
// The clicks go through the mouse, as a person's do: Playwright's own click refuses a spot something covers. The
// page is found by CSS, not by role: a modal menu hid the rest of the page from the accessibility tree.

const MENU = '[role=menu]'
const DRAWER = '[id^="headlessui-dialog-panel"]'

async function pressAt(page: Page, target: Locator) {
  const box = await target.boundingBox()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}
const DIALOG = '[role=dialog][aria-modal=true]'
const focusedText = (page: Page) => page.evaluate(() => (document.activeElement?.textContent ?? '').trim())

const headerText = (page: Page, name: string) =>
  page.locator('.ag-header-cell-text', { hasText: new RegExp(`^${name}$`) }).first()
const cell = async (page: Page, row: number) => {
  const id = await page.locator('.ag-header-cell').filter({ has: headerText(page, 'val') }).getAttribute('col-id')
  return page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="${id}"]`).first()
}
const scrollTop = (page: Page) => page.locator('.ag-body-viewport').first().evaluate(el => el.scrollTop)
// The menu has gone (at once: menus don't fade out).
const noMenu = (page: Page) => expect(page.locator(MENU)).toHaveCount(0)

test.beforeEach(async ({ page, context }) => {
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 200)
  const other = await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'other' } })
  expect(other.ok()).toBeTruthy()
  await context.addCookies((await api.storageState()).cookies)
  await api.dispose()
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
})

test('a toolbar menu: a click outside closes it and does nothing else, and focus goes back to its button', async ({
  page,
}) => {
  const data = page.getByTestId('data-menu')
  await data.click()
  await expect(page.locator(MENU)).toBeVisible()
  await pressAt(page, await cell(page, 3))
  await noMenu(page)
  await expect(data).toBeFocused()
  await expect(page.locator('.ag-cell-focus')).toHaveCount(0)

  // A button outside: the click only closes the menu (AI Column opens no drawer).
  await data.click()
  await expect(page.locator(MENU)).toBeVisible()
  await pressAt(page, page.locator('button[aria-label="AI Column"]'))
  await noMenu(page)
  await page.waitForTimeout(300)
  await expect(page.locator(DRAWER)).toHaveCount(0)
  await expect(data).toBeFocused()
})

test('the column menu: a click outside does nothing else, the wheel scrolls nothing behind, Escape closes it', async ({
  page,
}) => {
  await headerText(page, 'val').click()
  await expect(page.locator(MENU)).toBeVisible()
  const grid = await page.locator('.ag-body-viewport').first().boundingBox()
  await page.mouse.move(grid!.x + grid!.width / 2, grid!.y + grid!.height / 2)
  await page.mouse.wheel(0, 2_000)
  await page.waitForTimeout(300)
  expect(await scrollTop(page), 'the grid behind the menu').toBe(0)
  await expect(page.locator(MENU)).toBeVisible()

  // Another column's header: the menu closes, and that column's doesn't open.
  await pressAt(page, headerText(page, 'other'))
  await noMenu(page)
  await page.waitForTimeout(300)
  await expect(page.locator(MENU)).toHaveCount(0)

  // A cell: the menu closes, and the cell isn't selected.
  await headerText(page, 'val').click()
  await expect(page.locator(MENU)).toBeVisible()
  await pressAt(page, await cell(page, 3))
  await noMenu(page)
  await expect(page.locator('.ag-cell-focus')).toHaveCount(0)

  // Tab in its filter moves between the filter's fields and stays in the menu, keeping what was typed.
  await headerText(page, 'val').click()
  await expect(page.locator(MENU)).toBeVisible()
  const field = page.locator('[data-menu-field] input').first()
  await field.click()
  await field.pressSequentially('v1')
  for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) await page.keyboard.press(key)
  await expect(page.locator(MENU)).toBeVisible()
  expect(await page.evaluate(sel => !!document.activeElement?.closest(sel), MENU)).toBe(true)
  await expect(field).toHaveValue('v1')

  await page.keyboard.press('Escape')
  await noMenu(page)
})

test('a drawer a menu entry opens takes focus, and gives it back to the menu\'s button', async ({ page }) => {
  const more = page.getByTestId('more-menu')
  await more.click()
  await page.getByTestId('sheet-history').click()
  await expect(page.locator(DRAWER)).toBeVisible()
  await expect.poll(() => page.evaluate(sel => !!document.activeElement?.closest(sel), DIALOG),
    { message: 'focus is in the drawer' }).toBe(true)
  await page.waitForTimeout(400) // the menu has gone: it took nothing back
  expect(await page.evaluate(sel => !!document.activeElement?.closest(sel), DIALOG)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator(DRAWER)).toHaveCount(0)
  await expect(more).toBeFocused()
})

test('Escape closes the Data menu, and focus goes back to its button', async ({ page }) => {
  const data = page.getByTestId('data-menu')
  await data.click()
  await expect(page.locator(MENU)).toBeVisible()
  await page.keyboard.press('Escape')
  await noMenu(page)
  await expect(data).toBeFocused()
})

// Radix works out whether a menu is the top layer when it renders, and a menu just opened renders before it counts
// itself, so Radix drops an Escape pressed the moment the menu has focus; the menu closes on an Escape nothing
// handled (menu-shield.tsx). Ten rounds running, each Escape closes it at once and gives focus back to its button.
test('an Escape the moment a menu has focus closes it, ten times running', async ({ page }) => {
  const data = page.getByTestId('data-menu')
  for (let round = 1; round <= 10; round++) {
    await data.click()
    await expect(page.locator(MENU)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.locator(MENU), `round ${round}: still open`).toHaveCount(0, { timeout: 1_000 })
    await expect(data).toBeFocused()
  }
})

test('the keyboard: Enter or Space opens a menu, the arrows move, Enter picks', async ({ page }) => {
  const data = page.getByTestId('data-menu')
  await data.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(MENU)).toBeVisible()
  await expect.poll(() => focusedText(page)).toMatch(/^Import CSV/)
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => focusedText(page)).toMatch(/^Export/)
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => focusedText(page)).toMatch(/^Import CSV/)
  for (let i = 0; i < 6 && !/^Webhook/.test(await focusedText(page)); i++) {
    const was = await focusedText(page)
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => focusedText(page)).not.toBe(was)
  }
  await expect.poll(() => focusedText(page)).toMatch(/^Webhook/)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Webhook', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator(DRAWER)).toHaveCount(0)
  await expect(data).toBeFocused()

  const more = page.getByTestId('more-menu')
  await more.focus()
  await page.keyboard.press(' ')
  await expect(page.locator(MENU)).toBeVisible()
  await expect.poll(() => focusedText(page)).toMatch(/^Use a setup/)
  await page.keyboard.press('Escape')
  await noMenu(page)
  await expect(more).toBeFocused()
})

// New: a modal menu kept Tab in (Radix does, modal or not); this one fails on the menus before this change.
test('Tab on a menu entry closes the menu, and focus goes back to its button', async ({ page }) => {
  const more = page.getByTestId('more-menu')
  await more.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(MENU)).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await noMenu(page)
  await expect(more).toBeFocused()
})

test('two toolbar menus in a row: the second opens on the first click', async ({ page }) => {
  await page.getByTestId('data-menu').click()
  await expect(page.locator(MENU)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('more-menu').click() // at once, with no wait for the Data menu to go
  await expect(page.getByTestId('sheet-history')).toBeVisible()
})

// The dashboard's rows open their table on a click or on Enter, and each holds a ⋯ menu.
const DASH_ROW = 'div[role=button][tabindex="0"]:has(button[aria-label="Table actions"])'
const dashActions = (page: Page) => page.locator('button[aria-label="Table actions"]').first()

// The keys of a row's ⋯ button and menu reach the row through React too: only the row's own Enter opens the table.
test('the dashboard: Enter on a row\'s ⋯ opens its menu, Enter on an entry acts, the row\'s Enter opens it', async ({
  page,
}) => {
  await page.goto(`${BASE}/dashboard`)
  const actions = dashActions(page)
  await expect(actions).toBeVisible({ timeout: 15_000 })
  await actions.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(MENU)).toBeVisible()
  await expect.poll(() => focusedText(page)).toMatch(/^Rename/)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Rename Table' })).toBeVisible()
  await expect(page).toHaveURL(/\/dashboard$/)

  await page.goto(`${BASE}/dashboard`)
  await page.locator(DASH_ROW).first().focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/table\//)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  // A menu inside something a click opens: a dashboard row opens its table. The shield's events must not reach
  // the menu's React parents (a finger's tap ends with its click on the shield, under the open menu).
  test('a dashboard row\'s ⋯: a tap opens its menu and nothing else; a tap outside closes it and stays', async ({
    page,
  }) => {
    await page.goto(`${BASE}/dashboard`)
    const actions = dashActions(page)
    await expect(actions).toBeVisible({ timeout: 15_000 })
    const below = async () => {
      const box = await page.locator(DASH_ROW).last().boundingBox()
      await page.touchscreen.tap(195, Math.min(box!.y + box!.height + 120, 820))
    }
    await actions.tap()
    await expect(page.locator(MENU)).toBeVisible()
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.locator(MENU)).toBeVisible()

    await below()
    await noMenu(page)
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/\/dashboard$/)

    // Opened from the keyboard, then a tap outside.
    await actions.focus()
    await page.keyboard.press(' ')
    await expect(page.locator(MENU)).toBeVisible()
    await below()
    await noMenu(page)
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/\/dashboard$/)

    // Its entries can be reached: Rename opens its dialog, on the dashboard still.
    await actions.tap()
    await page.getByRole('menuitem', { name: 'Rename' }).tap()
    await expect(page.getByRole('heading', { name: 'Rename Table' })).toBeVisible()
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('a tap outside a menu closes it and does nothing else', async ({ page }) => {
    await page.getByTestId('data-menu').tap()
    await expect(page.locator(MENU)).toBeVisible()
    const box = await (await cell(page, 8)).boundingBox()
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await noMenu(page)
    await page.waitForTimeout(300)
    await expect(page.locator('.ag-cell-focus')).toHaveCount(0)
    await expect(page.locator(MENU)).toHaveCount(0)
  })
})

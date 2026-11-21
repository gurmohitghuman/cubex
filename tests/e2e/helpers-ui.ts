// UI helpers for the sheet toolbar's menus and the app's dropdowns (client
// components/ui/Select.tsx, components/sheet/toolbar/).
import { expect, type Locator, type Page } from '@playwright/test'

// Picks a value in one of the app's dropdowns, as selectOption did on the
// browser's: by its value (data-value) or by what it reads ({ label }).
// The list it opens is the one its button controls (aria-controls): the list a previous pick
// closed can still be fading out. An action list ("Insert a column…") keeps its value ''.
export async function choose(target: Locator, value: string | { label: string }): Promise<void> {
  await target.click()
  await expect(target).toHaveAttribute('aria-controls', /.+/)
  const list = target.page().locator(`[id="${await target.getAttribute('aria-controls')}"]`)
  const option = typeof value === 'string'
    ? list.locator(`[role="option"][data-value="${value.replace(/["\\]/g, '\\$&')}"]`)
    : list.getByRole('option', { name: value.label, exact: true })
  await option.click()
  // Closed before going on (focus is back on its button).
  await expect(list).toBeHidden()
  if (await target.getAttribute('data-action') !== null) return
  await expect(target).toHaveAttribute('data-value', typeof value === 'string' ? value : /.*/)
}

// The value a dropdown holds (what toHaveValue read on the browser's).
export const valueOf = (target: Locator) => target.getAttribute('data-value')

// Headless UI marks an element data-transition from its first render until its slide or fade is done (a drawer
// sliding in, a dialog fading out). Until then it can still move, and what is placed inside it moves with it:
// wait for none left before measuring where things are.
export const noTransition = (page: Page) => expect(page.locator('[data-transition]')).toHaveCount(0)

// The app's fonts come from the web and are swapped in when they arrive. Until then its text is drawn in a
// fallback font that wraps differently, so what sits below it moves when they do (a Settings row by 40 px).
// Waits for every font the page has asked for so far.
export const fontsLoaded = (page: Page) => page.evaluate(async () => { await document.fonts.ready })

// The toolbar's menus fade out when they close (about 150 ms), and a click on a menu's button while one is
// still fading out opens nothing: wait until none is left before opening the next (after Escape, say).
const noMenuOpen = (page: Page) => expect(page.getByRole('menu')).toHaveCount(0)

// Opens a kind of column from the arrow beside AI Column ("Enrichment", "Waterfall", "HTTP API",
// "Clean data", "Formula", "Lookup", "AI Column").
export async function openColumnType(page: Page, name: string): Promise<void> {
  await noMenuOpen(page)
  await page.getByTestId('column-types-menu').click()
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click()
}

// An entry of the Data menu ("Import CSV", "Export", "Export this view", "Export whole sheet",
// "Webhook", "Remove duplicates").
export async function openDataMenu(page: Page, entry: string): Promise<void> {
  await noMenuOpen(page)
  await page.getByTestId('data-menu').click()
  await page.getByRole('menuitem', { name: new RegExp(`^${entry}`) }).click()
}

// An entry of the ⋯ menu ("Use a setup…", "Save columns as a setup…", "This sheet's setup versions…",
// "Manage setups", "Usage", "History").
export async function openMoreMenu(page: Page, entry: string): Promise<void> {
  await noMenuOpen(page)
  await page.getByTestId('more-menu').click()
  await page.getByRole('menuitem', { name: new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
    .click()
}

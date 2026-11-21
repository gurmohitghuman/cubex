import { test, expect, type Page } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { openColumnType, openDataMenu } from './helpers-ui'

// A drawer or dialog closed right as it opens, with Escape or a click outside, closes, and the page takes the next
// click. Closed while its open transition still ran, Headless UI's Transition could stay on the page, invisible,
// catching every click until a reload; now a close asked for while it opens waits for the open to end
// (hooks/useCloseAfterOpen.ts).
//
// It went wrong when the browser drew a frame before React applied the close, as on a busy machine. To make that
// happen here, for a moment after each close, while the drawer or dialog is still in the page, React's work (its
// scheduler's message port) runs only after the next animation frame. Without the fix, many closes stick that
// way, so 5 rounds of each case catch it.
const ROUNDS = 5

async function reactAfterNextFrame(page: Page) {
  await page.addInitScript(() => {
    let until = 0
    const holding = () => performance.now() < until && !!document.querySelector('[role="dialog"]')
    const frame = window.requestAnimationFrame.bind(window)
    const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')!
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
      configurable: true,
      get() { return onmessage.get!.call(this) },
      set(handler: ((e: MessageEvent) => void) | null) {
        const port = this
        onmessage.set!.call(this, handler && ((e: MessageEvent) => {
          if (holding()) frame(() => setTimeout(() => handler.call(port, e), 0))
          else handler.call(port, e)
        }))
      },
    })
    const closing = () => { if (document.querySelector('[role="dialog"]')) until = performance.now() + 400 }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closing() }, true)
    document.addEventListener('pointerdown', closing, true)
  })
}

const opens: Record<string, (page: Page) => Promise<void>> = {
  'the AI drawer': page => page.getByRole('button', { name: 'AI Column', exact: true }).click(),
  'the HTTP API drawer': page => openColumnType(page, 'HTTP API'),
  'the Remove duplicates dialog': page => openDataMenu(page, 'Remove duplicates'),
}
const closes: Record<string, (page: Page) => Promise<void>> = {
  'Escape': page => page.keyboard.press('Escape'),
  'a click outside': page => page.mouse.click(30, 450),
}
const cases: Array<[string, string]> = [
  ['the AI drawer', 'Escape'], ['the HTTP API drawer', 'Escape'], ['the Remove duplicates dialog', 'Escape'],
  ['the AI drawer', 'a click outside'], ['the Remove duplicates dialog', 'a click outside'],
]

for (const [what, how] of cases) {
  test(`${what} closed with ${how} right as it opens closes, and the page takes a click`, async ({
    page, context,
  }) => {
    test.setTimeout(90_000)
    const api = await authedApi()
    const { tableId } = await seedSheet(api, 2)
    await context.addCookies((await api.storageState()).cookies)
    await reactAfterNextFrame(page)
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    for (let round = 1; round <= ROUNDS; round++) {
      await opens[what](page)
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await closes[how](page)
      await expect(page.locator('[role="dialog"]'), `round ${round}: still on the page`).toHaveCount(0)
      // The page takes a click: the Data menu opens, then closes again for the next round. Escape closes it once
      // it has focus.
      await page.getByTestId('data-menu').click({ timeout: 5_000 })
      await expect(page.getByRole('menu')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu')).toHaveCount(0)
    }
    await api.dispose()
  })
}

import { test, expect, type APIRequestContext } from '@playwright/test'
import { Receiver } from './helpers-receiver'
import { cellOf, colId, openTable, seedCellPanels } from './helpers-cell-panels'

// The answer and the trace a click on a grid cell opens sit beside the grid (components/SidePanel.tsx), on a sheet
// of 10,000 rows: focus goes into them and back to the cell on Escape or ×, another cell switches them, a click on
// a plain cell keeps them, one closes the other, and a double click edits the cell as before, also one the panel
// covered once open (its second click lands on the panel, which passes it on). How fast they come:
// cell-panels-speed.spec.ts.
const rx = new Receiver()
let api: APIRequestContext
let tableId = ''

test.beforeAll(async () => {
  test.setTimeout(120_000)
  await rx.start()
  const seeded = await seedCellPanels(rx)
  api = seeded.api
  tableId = seeded.tableId
})
test.afterAll(async () => { await rx.stop(); await api?.dispose() })

test('beside the grid: focus in and back, another cell switches it, a double click edits the cell', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  await openTable(page, context, api, tableId, 2560)
  const [title, name, found] = [await colId(page, 'Title'), await colId(page, 'Name'), await colId(page, 'Found email')]
  const answer = page.getByTestId('answer-panel')
  const side = page.getByTestId('side-panel')
  const editor = page.locator('.ag-popup-editor')
  const focusIn = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid=side-panel]'))
  const focused = () => page.evaluate(() => {
    const a = document.activeElement
    return `${a?.closest('.ag-row')?.getAttribute('row-index')}:${a?.getAttribute('col-id')}`
  })

  // It opens on the click with focus inside; another answer cell switches it, a plain cell leaves it.
  await cellOf(page, title, 0).click()
  await expect(answer).toContainText('Row 1 · Title')
  expect(await focusIn()).toBe(true)
  await cellOf(page, title, 2).click()
  await expect(answer).toContainText('Row 3 · Title')
  await expect(side).toHaveCount(1)
  expect(await focusIn()).toBe(true)
  await cellOf(page, name, 1).click()
  await expect(answer).toContainText('Row 3 · Title')
  // Escape closes it, and so does ×: focus goes back to the cell it opened from.
  await cellOf(page, title, 0).click()
  await expect(answer).toContainText('Row 1 · Title')
  await page.keyboard.press('Escape')
  await expect(side).toHaveCount(0)
  expect(await focused()).toBe(`0:${title}`)
  await cellOf(page, title, 1).click()
  await side.locator('button:has(svg.lucide-x)').click()
  await expect(side).toHaveCount(0)
  expect(await focused()).toBe(`1:${title}`)
  // A trace and an answer: one at a time.
  await cellOf(page, found, 0).click()
  await expect(page.getByTestId('waterfall-trace')).toBeVisible()
  await cellOf(page, title, 0).click()
  await expect(answer).toContainText('Row 1 · Title')
  await expect(page.getByTestId('waterfall-trace')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // A double click edits the cell, as before, with no panel left over it: on a cell clear of the panel...
  const clear = (await cellOf(page, title, 3).boundingBox())!
  expect(clear.x + clear.width, 'the cell is clear of the panel').toBeLessThan(2560 - 512)
  await cellOf(page, title, 3).dblclick()
  await expect(editor).toBeVisible()
  await expect(side).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  // ...and on one the panel covers once open: its second click lands on the panel, which passes it on. The two
  // presses go apart, with the panel on screen between them, as a person's do (a dblclick() sends both at once,
  // before the panel opens, so both would land on the cell).
  await page.setViewportSize({ width: 1000, height: 900 })
  await cellOf(page, title, 4).scrollIntoViewIfNeeded()
  const under = (await cellOf(page, title, 4).boundingBox())!
  expect(under.x, 'the cell is under the panel').toBeGreaterThan(1000 - 512)
  const at = { x: under.x + under.width / 2, y: under.y + under.height / 2 }
  await page.mouse.click(at.x, at.y)
  await expect(side).toBeVisible()
  expect(await page.evaluate(p => !!document.elementFromPoint(p.x, p.y)?.closest('[data-testid=side-panel]'), at),
    'the second press lands on the panel').toBe(true)
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
  await expect(editor).toBeVisible()
  await expect(side).toHaveCount(0)
  // Focus is in the editor: typing goes there.
  await page.keyboard.type('typed')
  await expect(editor.locator('textarea')).toHaveValue(/typed$/)
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  await expect(cellOf(page, title, 4)).not.toContainText('typed')
  // A double click on the panel later is the panel's own: it stays, and nothing edits.
  await cellOf(page, title, 4).click()
  await expect(answer).toContainText('Row 5 · Title')
  await answer.locator('h2').click()
  await answer.locator('h2').dblclick()
  await expect(answer).toBeVisible()
  await expect(editor).toHaveCount(0)
})

test('a click reads its answer at once, and an earlier click\'s slow answer never shows over it', async ({
  page, context,
}) => {
  test.setTimeout(60_000)
  await openTable(page, context, api, tableId, 2560)
  const email = await colId(page, 'Work email')
  const answer = page.getByTestId('answer-panel')
  // Row 1's answer comes back late, after row 3 was clicked and shown.
  let late: () => void = () => {}
  const held = new Promise<void>(r => { late = r })
  await page.route(/\/api\/enrich\/sheets\/[^/]+\/answer\?/, async route => {
    if (new URL(route.request().url()).searchParams.get('row') === '0') await held
    await route.continue()
  })
  const reads = () => page.evaluate(() => performance.getEntriesByType('resource')
    .filter(e => e.name.includes('/answer?')).length)
  await cellOf(page, email, 0).click()
  await expect(answer).toContainText('Row 1 · Work email')
  await expect(answer).toContainText('Loading the answer')
  await cellOf(page, email, 2).click()
  await expect(answer).toContainText('Row 3 · Work email')
  await expect(page.getByTestId('answer-summary')).toBeVisible()
  await expect(answer).toContainText('company3.example')
  const slow = page.waitForResponse(r => r.url().includes('/answer?') && r.url().includes('row=0'))
  late()
  await slow
  await page.waitForTimeout(300)
  await expect(answer).toContainText('Row 3 · Work email')
  await expect(answer).toContainText('company3.example')
  await expect(answer).not.toContainText('company1.example')
  // One read per click, and none more: the panel reads only on a click.
  expect(await reads()).toBe(2)
})

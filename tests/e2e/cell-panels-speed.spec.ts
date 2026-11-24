import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { Receiver } from './helpers-receiver'
import { clickToVisible, median } from './helpers-speed'
import { PANEL_ROWS, cellOf, colId, openTable, seedCellPanels } from './helpers-cell-panels'

// What a click on a grid cell opens is on screen at once (WORKFLOW Tests step 6), on a sheet of 10,000 rows: an
// HTTP API answer, an enrichment answer, a waterfall row's trace and a "(Data)" cell's sources each come on screen
// within their kind's budget (the median of 5 clicks; the rule is 100 ms, the budget leaves room for a slow run on
// the local runner), the side panels showing their loading state or their content in that first frame. A fixed wait
// before opening fails it: one was there until v0.8.43 (300 ms, to tell a double click apart). Menus, and drawers
// opened from them, the same: the second test.
// A trace records the page as it goes, which slows the very frames measured here: none in this file.
test.use({ trace: 'off' })

// The side panels: on screen in their first frame, about 30 ms here (medians up to 36 ms seen).
const SIDE_BUDGET_MS = 150
// The sources dialog: its open re-renders the grid and its fade starts from nothing, about 80 ms here (medians up to
// 98 ms seen in e2e:all). The waits sweep ("Every fixed wait in the app") brings it down, and this line with it.
const DIALOG_BUDGET_MS = 300
// Menus and the drawers opened from them: about 20 to 30 ms here (medians 18 to 32 seen), 130 to 350 ms before
// menus stopped being modal and toolbar entries stopped waiting for their menu to fade out.
const MENU_BUDGET_MS = 100
const SIDE = '[data-testid=side-panel]'
const MODAL = '[id^="headlessui-dialog-panel"]'
const KINDS = [
  { name: 'HTTP API answer', column: 'Title', panel: SIDE, content: '[data-testid=answer-tree]',
    budget: SIDE_BUDGET_MS },
  { name: 'enrichment answer', column: 'Work email', panel: SIDE, content: '[data-testid=answer-summary]',
    budget: SIDE_BUDGET_MS },
  { name: 'waterfall trace', column: 'Found email', panel: SIDE, content: '[data-testid=waterfall-trace-step]',
    budget: SIDE_BUDGET_MS },
  { name: 'sources', column: 'Research (Data)', panel: MODAL, content: '', budget: DIALOG_BUDGET_MS },
]
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

test('click to visible: each panel a cell opens is on screen within the budget, showing something', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  await openTable(page, context, api, tableId, 2560)
  const medians: Array<[string, number, number]> = []
  for (const k of KINDS) {
    const id = await colId(page, k.column)
    const ms: number[] = []
    for (let row = 0; row < 5; row++) {
      const o = await clickToVisible(page, cellOf(page, id, row), k.panel, k.content)
      ms.push(o.ms)
      if (k.panel === SIDE) expect(o.busy || o.content, `${k.name}, row ${row + 1}: empty when it came`).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.locator(k.panel)).toHaveCount(0)
    }
    medians.push([k.name, median(ms), k.budget])
    console.log(`click to visible, ${k.name}, ${PANEL_ROWS.toLocaleString()} rows: ${ms.join(', ')} ms`)
  }
  for (const [name, ms, budget] of medians) expect(ms, `${name}: median click to visible`).toBeLessThan(budget)
})

test('click to visible: the column menu, a toolbar menu and the drawers they open are on screen within 100 ms', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  await openTable(page, context, api, tableId, 2560)
  const MENU = '[role=menu]'
  const header = page.locator('.ag-header-cell').filter({ hasText: 'Work email' }).first()
    .locator('.ag-header-cell-text').first()
  const editEnrichment = page.getByRole('menuitem', { name: /Edit Enrichment/ })
  const opened = async (shown: Locator) => { await expect(shown).toBeVisible() }
  const kinds: Array<{ name: string; panel: string; target: (p: Page) => Locator; prep?: () => Promise<void> }> = [
    { name: 'column menu', panel: MENU, target: () => header },
    { name: 'Data menu', panel: MENU, target: p => p.getByTestId('data-menu') },
    { name: 'Edit Enrichment drawer, from the column menu', panel: MODAL, target: () => editEnrichment,
      prep: async () => { await header.click(); await opened(editEnrichment) } },
    { name: 'History drawer, from the More menu', panel: MODAL, target: p => p.getByTestId('sheet-history'),
      prep: async () => {
        await page.getByTestId('more-menu').click()
        await opened(page.getByTestId('sheet-history'))
      } },
  ]
  const medians: Array<[string, number]> = []
  for (const k of kinds) {
    const ms: number[] = []
    for (let i = 0; i < 5; i++) {
      await k.prep?.()
      const o = await clickToVisible(page, k.target(page), k.panel)
      ms.push(o.ms)
      // A drawer is on screen in the frame it is first drawn: it slides in its last quarter, as the side panels.
      if (k.panel === MODAL) expect(o.ms - o.drawn, `${k.name}: drawn off screen first`).toBeLessThanOrEqual(2)
      await page.keyboard.press('Escape')
      await expect(page.locator(k.panel)).toHaveCount(0)
    }
    medians.push([k.name, median(ms)])
    console.log(`click to visible, ${k.name}, ${PANEL_ROWS.toLocaleString()} rows: ${ms.join(', ')} ms`)
  }
  for (const [name, ms] of medians) expect(ms, `${name}: median click to visible`).toBeLessThan(MENU_BUDGET_MS)
})

import { test, expect, type APIRequestContext } from '@playwright/test'
import { Receiver } from './helpers-receiver'
import { clickToVisible, median } from './helpers-speed'
import { PANEL_ROWS, cellOf, colId, openTable, seedCellPanels } from './helpers-cell-panels'

// What a click on a grid cell opens is on screen at once (WORKFLOW Tests step 6), on a sheet of 10,000 rows: an
// HTTP API answer, an enrichment answer, a waterfall row's trace and a "(Data)" cell's sources each come on screen
// within BUDGET_MS of the click (the median of 5 clicks; the rule is 100 ms, this leaves room for a slow run on the
// local runner), the side panels showing their loading state or their content in that first frame. A fixed wait
// before opening fails it: one was there until v0.8.43 (300 ms, to tell a double click apart).
// A trace records the page as it goes, which slows the very frames measured here: none in this file.
test.use({ trace: 'off' })

const BUDGET_MS = 150
const SIDE = '[data-testid=side-panel]'
const MODAL = '[id^="headlessui-dialog-panel"]'
const KINDS = [
  { name: 'HTTP API answer', column: 'Title', panel: SIDE, content: '[data-testid=answer-tree]' },
  { name: 'enrichment answer', column: 'Work email', panel: SIDE, content: '[data-testid=answer-summary]' },
  { name: 'waterfall trace', column: 'Found email', panel: SIDE, content: '[data-testid=waterfall-trace-step]' },
  { name: 'sources', column: 'Research (Data)', panel: MODAL, content: '' },
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
  const medians: Record<string, number> = {}
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
    medians[k.name] = median(ms)
    console.log(`click to visible, ${k.name}, ${PANEL_ROWS.toLocaleString()} rows: ${ms.join(', ')} ms`)
  }
  for (const [name, ms] of Object.entries(medians)) {
    expect(ms, `${name}: median click to visible`).toBeLessThan(BUDGET_MS)
  }
})

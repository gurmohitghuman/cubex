import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { readDb, seedCsv } from './helpers-enrich'
import { call, mcpClient } from './helpers-mcp'
import { cellOf, colId } from './helpers-cell-panels'
import { clickToVisible, median } from './helpers-speed'

// "Why didn't this row run?" (services/skip-why.ts): a row an "Only run if" rule kept out ("⏭️ Condition not met")
// says why, free: read_rows include_status gives the cell a why, check_run_condition's failing sample rows too, and
// a click on the cell in the app opens a panel with the rule and each part the row fails. A row that passes now
// (its cells changed since) says so.

const CSV = ['Name,Tier', 'Maya,A', 'Leo,B', 'Ava,A', 'Sam,'].join('\n')
const RULE = '{{Tier}} is "A"'

test('a kept-out row says why: read_rows, check_run_condition and the grid\'s panel', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedCsv(api, CSV)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e skip why'))

  const checked = await call(client, 'check_run_condition', { sheet_id: sheetId, rule: RULE })
  expect(checked.sample.map((r: any) => r.why ?? null)).toEqual([
    null, ['Tier is "B"; the rule needs it to be "A".'], null, ['Tier is empty; the rule needs it to be "A".'],
  ])

  // A run with the rule: the B and empty rows are kept out at its start (the AI calls themselves fail here: no key).
  const ai = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Fit', prompt: 'Is /name a fit?', model: 'openai/gpt-4o-mini', run_if: RULE,
  })
  const keptOut = () => readDb(db => db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ?
    AND json_extract(data, '$."Fit (Output)"') = '⏭️ Condition not met'`).pluck().get(sheetId))
  await expect.poll(keptOut, { timeout: 30_000 }).toBe(2)
  await call(client, 'get_run', { action: 'status', run_type: 'ai', run_id: ai.run_id, wait_seconds: 5 })

  const read = await call(client, 'read_rows', { sheet_id: sheetId, include_status: true, columns: ['Fit (Output)'] })
  const cells = read.rows.map((r: any) => r.data['Fit (Output)'])
  expect(cells[1]).toMatchObject({ status: 'condition_not_met', why: ['Tier is "B"; the rule needs it to be "A".'] })
  expect(cells[3]).toMatchObject({ status: 'condition_not_met', why: ['Tier is empty; the rule needs it to be "A".'] })
  expect(cells[0].why).toBeUndefined()

  // The grid: a click on the kept-out cell shows the rule and why.
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  const fit = await colId(page, 'Fit (Output)')
  await cellOf(page, fit, 1).click()
  const panel = page.getByTestId('skip-why')
  await expect(panel).toContainText('Tier is "B"; the rule needs it to be "A".')
  await expect(panel).toContainText(RULE)
  await page.keyboard.press('Escape')

  // Its Tier filled since: it passes now, and the panel says a run would fill it.
  await call(client, 'update_cells', { sheet_id: sheetId, updates: [{ row_id: read.rows[1].id, data: { Tier: 'A' } }] })
  await page.reload()
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await cellOf(page, await colId(page, 'Fit (Output)'), 1).click()
  await expect(page.getByTestId('skip-why-passes')).toBeVisible()
  const again = await call(client, 'read_rows', { sheet_id: sheetId, include_status: true, columns: ['Fit (Output)'] })
  expect(again.rows[1].data['Fit (Output)'].why).toEqual(['It passes "Only run if" now: run it again to fill it.'])

  // The column the rule reads, deleted: the rule can't be checked (a rerun would refuse to start), never "passes".
  expect((await api.delete(`/api/sheets/${sheetId}/columns/Tier`)).status()).toBe(200)
  const gone = await call(client, 'read_rows', { sheet_id: sheetId, include_status: true, columns: ['Fit (Output)'] })
  expect(gone.rows[3].data['Fit (Output)'].why).toEqual([
    expect.stringContaining('This rule can\'t be checked: There\'s no column named "Tier".')])
})

// WORKFLOW Tests step 6: the panel is on screen within the side panels' budget (cell-panels-speed.spec.ts: 150 ms
// median, the rule's 100 with room for a slow run), its reasons may follow. 10,000 rows, every one kept out.
test('click to visible: the why panel on a 10,000-row sheet', async ({ page, context }) => {
  test.setTimeout(150_000)
  const api = await authedApi()
  const csv = ['Name,Tier', ...Array.from({ length: 10_000 }, (_, i) => `Person ${i},B`)]
  const { tableId, sheetId } = await seedCsv(api, csv.join('\n'))
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e skip why speed'))
  await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Fit', prompt: 'Is /name a fit?', model: 'openai/gpt-4o-mini', run_if: RULE,
  })
  const keptOut = () => readDb(db => db.prepare(`SELECT COUNT(*) FROM rows WHERE sheet_id = ?
    AND json_extract(data, '$."Fit (Output)"') = '⏭️ Condition not met'`).pluck().get(sheetId))
  await expect.poll(keptOut, { timeout: 60_000 }).toBe(10_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  const fit = await colId(page, 'Fit (Output)')
  const ms: number[] = []
  for (const row of [0, 2, 4, 6, 8]) {
    const o = await clickToVisible(page, cellOf(page, fit, row), '[data-testid=side-panel]')
    ms.push(o.ms)
    await expect(page.getByTestId('skip-why')).toContainText('Tier is "B"')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid=side-panel]')).toHaveCount(0)
  }
  console.log(`click to visible, why panel, 10,000 rows: ${ms.join(', ')} ms`)
  expect(median(ms), 'median click to visible').toBeLessThan(150)
})

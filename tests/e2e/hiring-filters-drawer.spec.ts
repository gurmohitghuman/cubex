import { test, expect } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { freshTreg, readDb } from './helpers-enrich'

// A Find jobs table made with More filters keeps its search's inputs as JSON templates read from its Searches
// columns (lib/hiring/search-input.ts). Its search column, opened from the column menu's Edit enrichment, runs
// again from the drawer with the same templates: the drawer may send a JSON template as a fixed value (it used to
// be refused: "can't contain {{"), and a text one with "{{" stays refused.
test('the drawer runs a filter table\'s search column again, its templates as they were', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const made = await api.post('/api/hiring', { data: { roles: ['SDR'], country: 'US', descriptionWords: 'outbound' } })
  expect(made.ok(), await made.text()).toBeTruthy()
  const h = (await made.json()).hiring
  // The search's input templates are its request body (lib/enrich-run-config.ts inputTemplates).
  const titlesOf = () => readDb(db => db.prepare(`SELECT json_extract(json_extract(config, '$.requestConfig.body'),
    '$.job_titles') FROM http_runs WHERE sheet_id = ? ORDER BY rowid DESC LIMIT 1`).pluck().get(h.searchesSheetId)) as
    string
  const before = titlesOf()
  expect(before).toContain('{{Role title}}')

  // Wide enough that the grid draws every Searches column, "Roles found" (the last) too.
  await page.setViewportSize({ width: 2200, height: 900 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${h.tableId}/${h.searchesSheetId}`)
  await page.locator('.ag-header-cell').filter({ hasText: 'Roles found' }).first()
    .locator('.ag-header-cell-text').first().click()
  await page.getByText('Edit enrichment').click()
  const drawer = page.getByTestId('enrich-drawer')
  await expect(drawer.getByTestId('enrich-run-all')).toHaveText(/^Run (all 1|on 1 row)$/, { timeout: 15_000 })
  await drawer.getByTestId('enrich-run-all').click()
  await page.getByRole('dialog').filter({ hasText: 'Run the enrichment' }).getByRole('button', { name: 'Run' }).click()
  await expect(drawer.getByTestId('enrich-run-headline')).toContainText('Ran', { timeout: 30_000 })
  expect(titlesOf()).toBe(before)
})

import { test, expect, Page } from '@playwright/test'
import path from 'path'
import { createRequire } from 'module'
import { authedApi, BASE, seedSheet, assertTestDb } from './helpers'
import { makeToken, bearer, httpConfig, waitForTerminal } from './api-v1-run-helpers'

// HTTP API columns get the answer panel too (plan U7; Verification 22): the
// result and the full response, with no cost or steps, and "Add as column" fills a
// new column from the stored responses without sending a request again (no
// new run, no result rewritten).
const require = createRequire(import.meta.url)

function storedResults(sheetId: string): Array<{ id: string; updated_at: string }> {
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(assertTestDb(process.env.DB_PATH), { readonly: true })
  try {
    return db.prepare(`SELECT r.id, r.updated_at FROM http_results r JOIN http_runs h ON h.id = r.run_id
      WHERE h.sheet_id = ? ORDER BY r.id`).all(sheetId)
  } finally { db.close() }
}

async function clickCell(page: Page, row: number, column: string) {
  const header = page.locator('.ag-header-cell').filter({ hasText: column }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  const id = await header.getAttribute('col-id')
  await page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="${id}"]`).first().click()
}

test('an HTTP API column: its response in the panel, and Add as column without new requests', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 2)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e http answer'))
  const run = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: httpConfig('https://jsonplaceholder.typicode.com/todos/1', 'Title'), master_column_name: 'Lookup' },
  })
  expect(run.status()).toBe(202)
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${(await run.json()).run_id}`)).status).toBe('completed')
  const runsBefore = (await (await api.get('/api/http/runs', { params: { sheetId } })).json()).length
  const results = storedResults(sheetId)
  expect(results).toHaveLength(2)

  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await clickCell(page, 0, 'Title')
  const panel = page.getByTestId('answer-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('HTTP API column')
  await expect(page.getByTestId('answer-result')).toContainText('delectus')
  await expect(page.getByTestId('answer-full')).toContainText('Full response')
  await expect(page.getByTestId('answer-steps')).toHaveCount(0)
  await expect(page.getByTestId('answer-cost')).toHaveCount(0)
  await expect(page.getByTestId('answer-rerun')).toHaveCount(0)
  await expect(page.getByTestId('answer-full')).toContainText('no new requests')

  const leaf = page.getByTestId('answer-tree').locator('[data-json-path="$.userId"]')
  await leaf.getByRole('button', { name: 'Column' }).click()
  await leaf.locator('input').fill('User')
  await leaf.locator('input').press('Enter')
  await expect(page.getByTestId('answer-added')).toContainText('Adding User')
  await expect.poll(async () => {
    const rows = (await (await api.get(`/api/sheets/${sheetId}?limit=10&offset=0`)).json()).data.rows
    return rows.map((r: any) => r.data.User ?? '')
  }, { timeout: 15_000 }).toEqual(['1', '1'])
  // No request went out again: the same runs, the same stored results, untouched.
  expect((await (await api.get('/api/http/runs', { params: { sheetId } })).json()).length).toBe(runsBefore)
  expect(storedResults(sheetId)).toEqual(results)
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('.ag-header-cell').filter({ hasText: '📎 User' })).toHaveCount(1, { timeout: 15_000 })
  await v1.dispose(); await api.dispose()
})

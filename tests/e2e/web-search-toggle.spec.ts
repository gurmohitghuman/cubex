import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'

// The AI Column modal's two independent web-data toggles + their persistence on
// the ai_runs record. Signs in through helpers like every other spec.

test('AI Column modal shows two distinct web-data toggles', async ({ page, context }) => {
  const api = await authedApi()
  // Share the cookie with the browser context.
  await context.addCookies((await api.storageState()).cookies)
  const { tableId } = await seedSheet(api, 1)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: /^AI Column$/ }).click()

  // Both inputs sit inside their <label>, so getByLabel resolves the checkbox.
  const webSearch = page.getByLabel('Web search', { exact: true })
  const webFetch = page.getByLabel('Fetch URLs from referenced columns')
  await expect(webSearch).toBeVisible()
  await expect(webFetch).toBeVisible()
  await expect(webSearch).not.toBeChecked()
  await expect(webFetch).not.toBeChecked()

  // Independent: toggling one never moves the other.
  await webSearch.check()
  await expect(webSearch).toBeChecked()
  await expect(webFetch).not.toBeChecked()

  await webFetch.check()
  await expect(webSearch).toBeChecked()
  await expect(webFetch).toBeChecked()

  await webSearch.uncheck()
  await expect(webSearch).not.toBeChecked()
  await expect(webFetch).toBeChecked()
  await api.dispose()
})

test('useOpenRouterWebSearch persists on the ai_runs record (independent of useWebFetch)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)

  // /ai/run INSERTs the ai_runs record before any OpenRouter call — the worker
  // fails the run later (seed user has no key), which this assertion never reaches.
  //
  // `model` is REQUIRED: there is deliberately no default AI model (migration 032
  // — explicit pick > sheet default > account default, else 400). This spec
  // predates that invariant and used to omit it, so the start 400'd before any
  // assertion ran. The model is never actually called here.
  const run = await api.post('/api/ai/run', {
    data: {
      sheetId,
      columnName: 'web_test',
      prompt: 'What does /val mean?',
      model: 'openai/gpt-4o-mini',
      useOpenRouterWebSearch: true,
      useWebFetch: false,
    },
  })
  expect(run.ok()).toBeTruthy()

  const runs = await api.get(`/api/ai/runs?sheetId=${sheetId}`)
  const list = (await runs.json()) as Array<{ use_openrouter_web_search: number; use_web_fetch: number }>
  expect(list.length).toBeGreaterThan(0)
  expect(list[0].use_openrouter_web_search).toBe(1)
  expect(list[0].use_web_fetch).toBe(0)
  await api.dispose()
})

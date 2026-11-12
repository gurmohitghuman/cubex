import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, BASE } from './helpers'
import { choose } from './helpers-ui'

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

// Web fetch limits (migration 055): the drawer shows them under "Fetch URLs" and sends them with a preview; the
// app's run start stores them on the run, and refuses a value out of range with the range.
test('web fetch limits: the drawer sends them, a run keeps them, and a bad one is refused', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await api.put(`/api/sheets/${sheetId}/default-model`, { data: { model: 'openai/gpt-4o-mini' } })).ok())
    .toBeTruthy()
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-fetch-limits-e2e' } })).ok())
    .toBeTruthy()
  try {
    await context.addCookies((await api.storageState()).cookies)
    let sent: Record<string, unknown> | null = null
    await page.route('**/api/ai/preview', async route => {
      sent = JSON.parse(route.request().postData() ?? '{}')
      await route.abort()
    })
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: /^AI Column$/ }).click()
    await expect(page.getByLabel('Tokens per page')).toBeHidden()
    await page.getByLabel('Fetch URLs from referenced columns').check()
    await page.getByLabel('Tokens per page').fill('2000')
    await choose(page.getByLabel('Pages per row'), '2')
    await expect(page.getByText('With a limit, pages are read through Exa, at about $0.001 a page.')).toBeVisible()
    await page.getByPlaceholder('e.g., Industry Analysis, Sentiment Score').fill('Fetched')
    await page.locator('#prompt').fill('Read /val')
    await page.getByRole('button', { name: /Try on/ }).click()
    await expect.poll(() => sent).not.toBeNull()
    expect(sent).toMatchObject({ useWebFetch: true, maxContentTokens: 2000, maxPagesPerRow: 2 })
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }

  const start = (extra: Record<string, unknown>) => api.post('/api/ai/run', { data: {
    sheetId, columnName: 'Fetch limits', prompt: 'Read /val', model: 'openai/gpt-4o-mini', useWebFetch: true, ...extra,
  } })
  const refused = await start({ maxPagesPerRow: 51 })
  expect(refused.status()).toBe(400)
  expect(await refused.json()).toEqual({ error: 'max_pages_per_row must be a whole number from 1 to 50.' })
  expect((await start({ maxContentTokens: '1500', maxPagesPerRow: 3 })).ok()).toBeTruthy()
  const runs = await (await api.get(`/api/ai/runs?sheetId=${sheetId}`)).json() as Array<Record<string, unknown>>
  expect(runs[0]).toMatchObject({ use_web_fetch: 1, web_fetch_max_content_tokens: 1500, web_fetch_max_pages: 3 })
  await api.dispose()
})

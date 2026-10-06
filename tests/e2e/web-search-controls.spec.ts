import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Web search cost controls: search_engine, search_mode and max_searches_per_row
// on run_ai_column (MCP and REST) and in the AI column drawer. No OpenRouter key
// here, so the engine catalog falls back to its static copy and rows fail fast;
// that still covers the plan (which engine, what price, whether a cap holds),
// the estimate, what a run stores and reports, and the drawer's controls. The
// searches themselves are covered by tests/unit/web-search-controls.test.ts.

function parse(res: { content?: Array<{ type: string; text?: string }> }): any {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('MCP and REST: engine, mode and per-row cap are planned, priced, stored and reported', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 4)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e web search controls')
  const client = new Client({ name: 'e2e-web-search-controls', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  const call = (args: object) => client.callTool({ name: 'run_ai_column', arguments: { sheet_id: sheetId, prompt: 'Find /val', ...args } })
  const base = { column_name: 'Lookup', model: 'openai/gpt-4o-mini' }

  // Parallel in fast mode, at most one search a row. Booleans and the cap sent
  // as text, the way a client with an older tool list sends them.
  const est = parse(await call({ ...base, web_search: 'true', estimate_only: 'true', search_engine: 'parallel', search_mode: 'fast', max_searches_per_row: '1' }))
  expect(est.rows_to_process).toBe(4)
  expect(est.web_search.runs_on).toBe('parallel')
  expect(est.web_search.mode).toBe('fast')
  expect(est.web_search.price_per_search_usd).toBe(0.001)
  expect(est.web_search.searches_per_row).toEqual({ low: 1, high: 1 })
  expect(est.web_fees_usd).toEqual({ low: 0.004, high: 0.004 })
  expect(est.note).toContain('Parallel (fast mode) at $0.001 a search')

  // Auto with a cap on a model whose own search ignores caps: Exa, and it says so.
  const switched = parse(await call({ ...base, model: 'openai/gpt-5.4', web_search: true, estimate_only: true, max_searches_per_row: 2 }))
  expect(switched.web_search.runs_on).toBe('exa')
  expect(switched.web_search.note).toContain("can't be limited per row")
  // The same cap with an explicit native engine is refused, with the options.
  const refused: any = await call({ ...base, model: 'openai/gpt-5.4', web_search: true, estimate_only: true, search_engine: 'native', max_searches_per_row: 2 })
  expect(refused.isError).toBeTruthy()
  expect(JSON.stringify(refused.content)).toContain("can't be limited per row")
  // Auto without a cap on that model: its own search, at OpenAI's price.
  const native = parse(await call({ ...base, model: 'openai/gpt-5.4', web_search: true, estimate_only: true }))
  expect(native.web_search.runs_on).toBe('native')
  expect(native.web_search.price_per_search_usd).toBe(0.01)
  // Search options without web search are refused rather than ignored.
  const noSearch: any = await call({ ...base, estimate_only: true, search_engine: 'exa' })
  expect(noSearch.isError).toBeTruthy()

  // A started run stores and reports its settings and what it has spent.
  const started = parse(await call({ ...base, web_search: 'true', search_engine: 'Parallel', search_mode: 'fast', max_searches_per_row: 1 }))
  expect(started.web_search).toMatchObject({ engine: 'parallel', runs_on: 'parallel', mode: 'fast', max_searches_per_row: 1 })
  let status: any = null
  for (let i = 0; i < 60; i++) {
    status = parse(await client.callTool({ name: 'get_run_status', arguments: { run_type: 'ai', run_id: started.run_id } }))
    if (['completed', 'failed', 'cancelled'].includes(status?.status)) break
    await new Promise(r => setTimeout(r, 500))
  }
  expect(status.web_search).toEqual({ engine: 'parallel', runs_on: 'parallel', mode: 'fast', max_searches_per_row: 1 })
  // Without a key the run fails before any row is sent: nothing billed, nothing searched.
  expect(status.cost_usd).toBeNull()
  expect(status.searches).toBeNull()

  // REST: the same arguments, and a switch must be a real true/false.
  const rest = await api.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { ...base, prompt: 'Find /val', web_search: true, estimate_only: true, search_engine: 'exa', search_mode: 'deep' },
  })
  expect(rest.status()).toBe(200)
  expect((await rest.json()).web_search).toMatchObject({ runs_on: 'exa', mode: 'deep', price_per_search_usd: 0.012 })
  const vague = await api.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { ...base, prompt: 'Find /val', web_search: 'maybe', estimate_only: true },
  })
  expect(vague.status()).toBe(400)
  await client.close()
  await api.dispose()
})

test('AI column drawer: engine, mode and limit, with the price of what will run', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e web search drawer')
  const client = new Client({ name: 'e2e-web-search-drawer', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  // The drawer prices for the sheet's model.
  await client.callTool({ name: 'set_default_model', arguments: { model: 'openai/gpt-5.4', sheet_id: sheetId } })
  await client.close()

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: /^AI Column$/ }).click()
  await page.getByLabel('Web search', { exact: true }).check()

  const engine = page.getByLabel('Search engine')
  const mode = page.getByLabel('Mode', { exact: true })
  const cap = page.getByLabel('Searches per row')
  await expect(engine).toHaveValue('auto')
  await expect(mode).toBeDisabled()
  const plan = page.getByTestId('web-search-plan')
  await expect(plan).toContainText("OpenAI's own search at OpenAI's list price of $0.01 a search")

  await engine.selectOption('parallel')
  await expect(mode).toBeEnabled()
  await mode.selectOption('fast')
  await cap.selectOption('1')
  await expect(plan).toContainText('Parallel (fast mode) at $0.001 a search')
  await expect(plan).toContainText('Up to 1 search a row, so at most $0.001 a row in search fees.')

  // A limit OpenAI's own search can't keep: refused, and the preview button says why.
  await page.getByPlaceholder('e.g., Industry Analysis, Sentiment Score').fill('Lookup')
  await page.locator('#prompt').fill('Find /val')
  await engine.selectOption('native')
  await expect(page.getByRole('alert')).toContainText("can't be limited per row")
  await expect(page.getByRole('button', { name: /Try on/ })).toBeDisabled()
  await expect(page.getByText('Change the web search settings to continue.')).toBeVisible()
  // Auto with the same limit runs on Exa instead, and says so.
  await engine.selectOption('auto')
  await expect(plan).toContainText('this run uses Exa instead')
  await expect(page.getByRole('button', { name: /Try on/ })).toBeEnabled()
  await api.dispose()
})

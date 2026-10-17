import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken, BASE } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// "Run First Rows" on AI and HTTP API columns: a rerun on the sheet's top N
// rows only (a test before a big run), from the column menu's dialog, the app
// route, /api/v1 and MCP control_run. An AI column's rows fail fast for free
// on a fake OpenRouter key; the HTTP API column calls jsonplaceholder.

const header = (page: import('@playwright/test').Page, name: string) =>
  page.locator('.ag-header-cell').filter({ hasText: name }).first()

// No run of that kind is working on the sheet any more (a rerun 409s while one is).
async function settled(api: APIRequestContext, kind: 'ai' | 'http', sheetId: string) {
  await expect.poll(async () => {
    const runs = await (await api.get(`/api/${kind}/runs?sheetId=${sheetId}`)).json() as any[]
    return runs.some(r => ['pending', 'running', 'paused'].includes(r.status) || r.placeholder_work)
  }, { timeout: 30_000 }).toBe(false)
}

test('Run First Rows reruns only the top rows: app, REST, MCP and the column menu', async ({ page, context }) => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 5)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'first-rows')
  const client = await mcpClient(token)
  const v1 = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })

  // HTTP API column on every row, then its first rows again.
  const http = await call(client, 'run_http_enrichment', { sheet_id: sheetId,
    url: 'https://jsonplaceholder.typicode.com/posts/1?v={{val}}', master_column_name: 'Lookup',
    response_mapping: [{ json_path: '$.id', column_name: 'Post id' }] })
  await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'http', run_id: http.run_id }))
    .status, { timeout: 30_000 }).toBe('completed')
  const bad = await api.post('/api/http/rerun', { data: { sheetId, masterColumnName: 'Lookup', firstRows: 0 } })
  expect(bad.status()).toBe(400)
  const both = await api.post('/api/http/rerun', { data: { sheetId, masterColumnName: 'Lookup', firstRows: 2,
    rowIndices: [0] } })
  expect(await both.text()).toContain('not both')
  const app = await api.post('/api/http/rerun', { data: { sheetId, masterColumnName: 'Lookup', firstRows: 2 } })
  expect(app.ok(), await app.text()).toBeTruthy()
  const appRun = await app.json()
  expect(appRun.targetRows).toBe(2)
  await settled(api, 'http', sheetId)
  const viaMcp = await call(client, 'control_run', { run_type: 'http', run_id: appRun.runId, action: 'rerun',
    first_rows: 3 })
  expect(viaMcp.target_rows).toBe(3)
  await settled(api, 'http', sheetId)
  expect(await callError(client, 'control_run', { run_type: 'http', run_id: viaMcp.run_id, action: 'pause',
    first_rows: 3 })).toContain('first_rows applies only')

  // AI column (rows fail on the fake key), then its first rows again through /api/v1.
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    const ai = await call(client, 'run_ai_column', { sheet_id: sheetId, column_name: 'Fit',
      prompt: 'Is /val a fit?', model: 'deepseek/deepseek-v4-flash' })
    await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'ai', run_id: ai.run_id }))
      .status, { timeout: 30_000 }).toMatch(/completed|failed/)
    const rest = await v1.post(`/api/v1/ai-runs/${ai.run_id}/rerun`, { data: { first_rows: 1 } })
    expect(rest.status(), await rest.text()).toBe(202)
    expect((await rest.json()).target_rows).toBe(1)
    await settled(api, 'ai', sheetId)
    const appAi = await api.post('/api/ai/rerun', { data: { sheetId, baseColumnName: 'Fit', mode: 'all',
      firstRows: 4 } })
    expect((await appAi.json()).targetRows).toBe(4)
    await settled(api, 'ai', sheetId)

    // The column menu's dialog.
    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(header(page, 'Lookup')).toBeVisible({ timeout: 15_000 })
    await header(page, 'Lookup').locator('.ag-header-cell-text').first().click()
    await page.getByRole('menuitem', { name: /Run First Rows/ }).click()
    const dialog = page.getByTestId('first-rows-dialog')
    await expect(dialog).toContainText('Lookup')
    await page.getByTestId('first-rows-count').fill('2')
    await page.getByTestId('first-rows-run').click()
    await expect(page.getByText('Re-running HTTP for 2 rows')).toBeVisible()
    await settled(api, 'http', sheetId)
    await header(page, 'Fit (Output)').locator('.ag-header-cell-text').first().click()
    await page.getByRole('menuitem', { name: /Run First Rows/ }).click()
    await expect(dialog).toContainText('OpenRouter credits')
    await page.getByTestId('first-rows-count').fill('3')
    await page.getByTestId('first-rows-run').click()
    await expect(page.getByText('Re-running AI for 3 rows')).toBeVisible()
    await settled(api, 'ai', sheetId)
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
})

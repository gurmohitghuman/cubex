import { test, expect, type Page } from '@playwright/test'
import { authedApi, BASE, getSheet, makeAccessToken } from './helpers'
import { call, callError, mcpClient } from './helpers-mcp'

// Try with sample data: the empty dashboard offers it; the New Table dialog
// makes it and opens the sheet, with the free columns filled, the guide on top
// (the duplicate found, the AI column not run), the AI drawer pre-filled from
// it and Remove duplicates finding the planted duplicate. Nothing runs. It goes
// to the trash like any table. Agents make it over REST and MCP, told it's
// fictional and how to run the AI column. The guide doesn't re-check a big
// sheet and moves on when an AI column of any name has run; a make the browser
// timed out on opens the table the server made instead of inviting a second.

const shots = process.env.E2E_SHOTS
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }) }

test('the empty dashboard offers sample data', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  // Other specs leave tables behind: answer the list as empty.
  await page.route('**/api/tables', route => (route.request().method() === 'GET'
    ? route.fulfill({ json: [] }) : route.continue()))
  await page.goto(`${BASE}/dashboard`)
  await expect(page.getByText('No tables yet')).toBeVisible()
  await expect(page.getByTestId('try-sample')).toHaveText('Try with sample data')
  await shot(page, 'sample-empty-dashboard')
})

test('Try with sample data in the New Table dialog', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('button', { name: 'New Table' }).click()
  await page.getByRole('dialog').getByTestId('try-sample').click()
  await expect(page).toHaveURL(/\/table\/[0-9a-f-]+\/[0-9a-f-]+$/, { timeout: 15_000 })
  const sheetId = page.url().split('/').pop()!

  const guide = page.getByTestId('sample-guide')
  await expect(guide).toContainText('Sample data: everything here is made up')
  await expect(guide).toContainText('Row 18 repeats row 3', { timeout: 15_000 })
  await expect(page.getByText('25 rows')).toBeVisible()
  await expect(page.locator('.ag-header-cell-text', { hasText: 'Good fit (Output)' })).toBeVisible()
  await shot(page, 'sample-sheet')

  const data = (await getSheet(api, sheetId)).data
  expect(data.sample).toBe(true)
  expect(data.columns).toEqual(['Name', 'Company', 'Company (clean)', 'Title', 'Seniority', 'Good fit (Output)',
    'Email', 'Website'])
  expect(data.rows[1].data['Company (clean)']).toBe('Harborline Freight')
  expect(data.rows[0].data.Seniority).toBe('Leader')
  expect(data.rows.every((r: any) => !r.data['Good fit (Output)'])).toBe(true)
  expect(Object.keys(data.columnDescriptions)).toHaveLength(8)

  // The AI drawer opens with the sample's prompt and name; nothing has run.
  await page.getByTestId('sample-try-ai').click()
  await expect(page.locator('#prompt')).toHaveValue(/Company: \/Company\nPerson's title: \/Title/)
  await expect(page.getByPlaceholder('e.g., Industry Analysis, Sentiment Score')).toHaveValue('Good fit')
  // Disabled until a model is picked: the account has no default.
  await expect(page.getByRole('button', { name: 'Try on 5 rows', exact: true })).toBeDisabled()
  await shot(page, 'sample-ai-drawer')
  await page.keyboard.press('Escape')
  expect(await (await api.get(`/api/ai/runs?sheetId=${sheetId}`)).json()).toEqual([])

  // Remove duplicates finds Priya Raman's second row.
  await page.getByRole('button', { name: 'Review duplicates' }).click()
  await expect(page.getByTestId('dedupe-summary')).toHaveText('1 duplicate row in 1 group. 24 rows stay.',
    { timeout: 15_000 })
  await expect(page.getByTestId('dedupe-samples')).toContainText('Priya.Raman@Quillstone.EXAMPLE')

  // Like any table: into the trash.
  const tableId = page.url().split('/').at(-2)!
  const del = await api.delete(`/api/tables/${tableId}`)
  expect((await del.json()).trash?.id).toBeTruthy()
})

test('agents make the sample over REST and MCP', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read', 'write'], `sample-${Date.now()}`)
  const rest = await api.post('/api/v1/tables/sample', { headers: { Authorization: `Bearer ${token}` }, data: {} })
  expect(rest.status()).toBe(201)
  const made = await rest.json()
  expect(made.sheet.row_count).toBe(25)
  expect(made.fictional).toMatch(/made up/)
  expect(made.filled_free).toEqual(['Company (clean)', 'Seniority'])
  expect(made.duplicates.groups).toEqual([{ kept_row: 3, duplicate_rows: [18] }])
  expect(made.ai_column.ran).toBe(false)
  expect(made.ai_column.target_row_ids).toHaveLength(5)
  expect(made.ai_column.next).toMatch(/POST \/sheets\/.+\/ai-runs/)

  const readOnly = await makeAccessToken(api, ['read'], `sample-ro-${Date.now()}`)
  const refused = await api.post('/api/v1/tables/sample', { headers: { Authorization: `Bearer ${readOnly}` } })
  expect(refused.status()).toBe(403)

  const client = await mcpClient(token)
  try {
    const viaMcp = await call(client, 'manage_table', { action: 'create_sample' })
    expect(viaMcp.table.name).toMatch(/^Sample leads/)
    expect(viaMcp.ai_column.next).toMatch(/run_ai_column/)
    const { tools } = await client.listTools()
    expect(tools.find(t => t.name === 'manage_table')?.description).toMatch(/made-up leads/)
    const ro = await mcpClient(readOnly)
    expect(await callError(ro, 'manage_table', { action: 'create_sample' })).toMatch(/scope/i)
    await ro.close()
    for (const id of [made.table.id, viaMcp.table.id]) await api.delete(`/api/tables/${id}`)
  } finally {
    await client.close()
  }
})

// Makes a sample table over the app's own route and opens it.
async function openSample(page: Page) {
  const api = await authedApi()
  await page.context().addCookies((await api.storageState()).cookies)
  const made = await (await api.post('/api/tables/sample', { data: {} })).json()
  return { api, tableId: made.id as string, sheetId: made.sheetId as string }
}

test('the guide: no re-check of a big sheet, and an AI column under any name counts as run', async ({ page }) => {
  test.setTimeout(60_000)
  const { api, tableId, sheetId } = await openSample(page)
  const checks: string[] = []
  page.on('request', r => { if (r.url().includes('/duplicates/check')) checks.push(r.url()) })
  // The sheet as a big one (an import grew it) with an AI column the person named "Fit".
  await page.route(u => u.pathname === `/api/sheets/${sheetId}`, async route => {
    const res = await route.fetch()
    const body = await res.json()
    body.data.totalRows = 5_000
    body.data.columns = [...body.data.columns, 'Fit (Output)']
    body.data.columnTypes = { ...(body.data.columnTypes ?? {}), 'Fit (Output)': 'ai-output' }
    await route.fulfill({ response: res, json: body })
  })
  await page.goto(`${BASE}/table/${tableId}/${sheetId}`)
  const guide = page.getByTestId('sample-guide')
  await expect(guide).toContainText('Priya Raman is in the list twice')
  await expect(guide).toContainText('You ran Fit (Output).')
  await expect(page.getByTestId('sample-try-ai')).toHaveCount(0)
  await page.waitForTimeout(1_000)
  expect(checks).toEqual([])
  await api.delete(`/api/tables/${tableId}`)
})

test('a make the browser gave up on opens the table the server made, never a second', async ({ page }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await page.context().addCookies((await api.storageState()).cookies)
  const samples = async () => ((await (await api.get('/api/tables')).json()) as Array<{ id: string; name: string }>)
    .filter(t => /^Sample leads( \d+)?$/.test(t.name)).map(t => t.id)
  const before = await samples()
  // The server makes it; the browser sees a timeout.
  await page.route('**/api/tables/sample', async route => { await route.fetch(); await route.abort('timedout') })
  await page.goto(`${BASE}/dashboard`)
  await page.getByRole('button', { name: 'New Table' }).click()
  await page.getByRole('dialog').getByTestId('try-sample').click()
  await expect(page).toHaveURL(/\/table\/[0-9a-f-]+\/[0-9a-f-]+$/, { timeout: 30_000 })
  const made = (await samples()).filter(id => !before.includes(id))
  expect(made).toHaveLength(1)
  expect(page.url()).toContain(`/table/${made[0]}/`)
  await expect(page.getByText('Could not make the sample table.')).toHaveCount(0)
  await api.delete(`/api/tables/${made[0]}`)
})

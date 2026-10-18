// Over 200 lines: one spec of the run controls, the HTTP, AI and waterfall cases sharing its receiver and token.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, seedSheet, importCsv, BASE } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { Receiver } from './helpers-receiver'

// Run controls: a result goes out of date when an input cell it was made from
// changes (read with include_status, found by `where`, rerun with mode
// out_of_date over REST and MCP), the column menu's "Run N empty or
// out-of-date rows" and "Force run all N rows" with their estimate first, a
// cell's play button with its row's cost, and the header's one-click
// "N failed, retry". An HTTP API column calls a local receiver
// (tests/e2e/net-shim.cjs); an AI column fails fast for free on a fake
// OpenRouter key. Screenshots land in test-results/shots/.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
let token: string

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  rx.on('/echo', { status: 200, body: '{"ok":"yes"}' })
  api = await authedApi()
  token = await makeToken(api, ['read', 'write', 'run'], 'run controls spec')
  v1 = await bearer(token)
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/shots/${name}.png` })
const header = (page: Page, name: string) => page.locator('.ag-header-cell').filter({ hasText: name }).first()
// Its menu opens from the name (the "N failed, retry" badge beside it runs the retry instead).
const openMenu = (page: Page, name: string) =>
  header(page, name).locator('.ag-header-cell-text > div').first().click()
async function cell(page: Page, column: string, row: number) {
  const colId = await header(page, column).getAttribute('col-id')
  return page.locator(`.ag-center-cols-container .ag-row[row-index="${row}"] .ag-cell[col-id="${colId}"]`)
}

async function sheetWith(csv: string): Promise<{ tableId: string; sheetId: string }> {
  const s = await seedSheet(api, 1)
  expect((await importCsv(api, s.sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  return s
}
const edit = async (sheetId: string, rowIndex: number, columnName: string, value: string) =>
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [{ rowIndex, columnName, value }] } }))
    .ok()).toBeTruthy()
const statuses = async (sheetId: string, column: string) =>
  ((await (await v1.get(`/api/v1/sheets/${sheetId}/rows?include_status=true`)).json()).rows as
    Array<{ data: Record<string, { status: string; value: string | null }> }>).map(r => r.data[column].status)
const hitsFor = (name: string) => rx.hitsOn('/echo').filter(h => h.query.get('n') === name).length

test('out of date: an edited input marks its row; REST, MCP and the column menu run it again', async ({
  page, context,
}) => {
  test.setTimeout(150_000)
  const { tableId, sheetId } = await sheetWith('Name\nAda\nBo\nCy\n')
  const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url('/echo?n={{Name}}'), master_column_name: 'Call',
    response_mapping: [{ json_path: '$.ok', column_name: 'OK' }],
  } })
  expect(start.status(), await start.text()).toBe(202)
  await waitForTerminal(v1, `/api/v1/http-runs/${(await start.json()).run_id}`)
  expect(await statuses(sheetId, 'Call')).toEqual(['done', 'done', 'done'])

  // An input changes: that row's results (status and output column) are out of date.
  await edit(sheetId, 1, 'Name', 'Bob')
  expect(await statuses(sheetId, 'Call')).toEqual(['done', 'out_of_date', 'done'])
  expect(await statuses(sheetId, 'OK')).toEqual(['done', 'out_of_date', 'done'])
  const counted = await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, {
    data: { where: [{ operator: 'out_of_date' }], return_mode: 'count' } })
  expect((await counted.json()).count).toBe(1)

  // REST: only the out-of-date row runs again, with the new value.
  const runs = await (await v1.get(`/api/v1/runs?sheet_id=${sheetId}`)).json()
  const rest = await v1.post(`/api/v1/http-runs/${runs.runs[0].id}/rerun`, { data: { mode: 'out_of_date' } })
  expect(rest.status(), await rest.text()).toBe(202)
  const restRun = await rest.json()
  expect(restRun.target_rows).toBe(1)
  await waitForTerminal(v1, `/api/v1/http-runs/${restRun.run_id}`)
  expect(hitsFor('Bob')).toBe(1)
  expect(await statuses(sheetId, 'Call')).toEqual(['done', 'done', 'done'])

  // MCP: empty_or_out_of_date takes the next edited row (none is empty).
  await edit(sheetId, 2, 'Name', 'Cyd')
  const client = await mcpClient(token)
  const mcp = await call(client, 'control_run', { run_type: 'http', run_id: restRun.run_id, action: 'rerun',
    mode: 'empty_or_out_of_date' })
  expect(mcp.target_rows).toBe(1)
  await waitForTerminal(v1, `/api/v1/http-runs/${mcp.run_id}`)
  expect(hitsFor('Cyd')).toBe(1)
  expect(await callError(client, 'control_run', { run_type: 'http', run_id: mcp.run_id, action: 'rerun',
    mode: 'out_of_date' })).toMatch(/No target rows/)
  const counts = await (await api.get(`/api/run-controls/sheets/${sheetId}/counts?column=OK`)).json()
  expect(counts).toEqual({ kind: 'http', column: 'Call', total: 3, empty: 0, outOfDate: 0, failed: 0 })

  // The column menu: its numbers, the estimate's confirm, then the run.
  await edit(sheetId, 0, 'Name', 'Adah')
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await openMenu(page, 'Call')
  const menu = page.getByRole('menu')
  await expect(menu.getByTestId('run-stale')).toHaveText(/Run 1 empty or out-of-date row$/)
  await expect(menu.getByTestId('run-all')).toHaveText(/Force run all 3 rows/)
  await expect(menu.getByTestId('run-failed')).toHaveText(/Retry 0 failed rows/)
  await expect(menu.getByTestId('run-failed')).toBeDisabled()
  await shot(page, 'run-controls-menu')
  await menu.getByTestId('run-stale').click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Run empty or out-of-date rows' })
  await expect(dialog).toContainText('Run 1 row that is empty or out of date?')
  await expect(dialog).toContainText('Cubex has no price for it')
  await shot(page, 'run-controls-confirm')
  await dialog.getByRole('button', { name: 'Run' }).click()
  await expect.poll(() => hitsFor('Adah'), { timeout: 20_000 }).toBe(1)

  // A cell's play button: its row's cost on hover, one click runs the row alone.
  await expect.poll(async () => (await statuses(sheetId, 'Call')).join(','), { timeout: 20_000 })
    .toBe('done,done,done')
  await page.reload()
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  const target = await cell(page, 'OK', 2)
  await target.hover()
  const play = target.getByTestId('run-row')
  await expect(play).toBeVisible()
  await play.hover()
  await expect(play.getByTestId('run-row-cost')).toHaveText('1 request')
  await expect(play).toHaveAttribute('title', 'Run this row (1 request)')
  await shot(page, 'run-controls-play')
  // A new run of that row alone (its GET may be answered from Cubex's cache, so not counted at the receiver).
  const runCount = async () => (await (await v1.get(`/api/v1/runs?sheet_id=${sheetId}`)).json()).runs as
    Array<{ id: string; total_rows: number }>
  const before = (await runCount()).length
  await play.click()
  await expect.poll(async () => (await runCount()).length, { timeout: 20_000 }).toBe(before + 1)
  const rowRun = await waitForTerminal(v1, `/api/v1/http-runs/${(await runCount())[0].id}`)
  expect(rowRun.total_rows).toBe(1)
  // The click ran the row only: no answer panel opened over it (a click on the cell would, 300 ms later).
  await page.waitForTimeout(800)
  await expect(page.getByTestId('answer-panel')).toHaveCount(0)
  // Clicking the cell itself still opens its answer.
  await target.click()
  await expect(page.getByTestId('answer-panel')).toBeVisible({ timeout: 5_000 })
})

test('the header\'s "N failed, retry" runs the failed rows again in one click', async ({ page, context }) => {
  test.setTimeout(150_000)
  const { tableId, sheetId } = await sheetWith('Name\nAda\nBo\n')
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    const client = await mcpClient(token)
    const ai = await call(client, 'run_ai_column', { sheet_id: sheetId, column_name: 'Blurb',
      prompt: 'Describe /name', model: 'deepseek/deepseek-v4-flash' })
    await waitForTerminal(v1, `/api/v1/ai-runs/${ai.run_id}`)
    // A failed row is failed, not out of date, whatever its inputs do.
    await edit(sheetId, 0, 'Name', 'Ada2')
    expect(await callError(client, 'control_run', { run_type: 'ai', run_id: ai.run_id, action: 'rerun',
      mode: 'out_of_date' })).toMatch(/No target rows/)

    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    const badge = header(page, 'Blurb (Output)').getByTestId('retry-failed')
    // A narrow column shows the count and a retry icon (named "2 failed, retry"); a wide one the words.
    await expect(badge).toHaveAccessibleName('2 failed, retry', { timeout: 15_000 })
    await expect(badge).toHaveText('2')
    await shot(page, 'run-controls-failed-badge')
    await openMenu(page, 'Blurb (Output)')
    await expect(page.getByRole('menu').getByTestId('run-failed')).toHaveText(/Retry 2 failed rows/)
    await page.keyboard.press('Escape')

    const before = (await (await v1.get(`/api/v1/runs?sheet_id=${sheetId}`)).json()).runs.length
    await badge.click()
    await expect(page.getByText('Retrying 2 failed rows')).toBeVisible()
    await expect.poll(async () => (await (await v1.get(`/api/v1/runs?sheet_id=${sheetId}`)).json()).runs.length,
      { timeout: 20_000 }).toBe(before + 1)
    const runs = (await (await v1.get(`/api/v1/runs?sheet_id=${sheetId}`)).json()).runs
    await waitForTerminal(v1, `/api/v1/ai-runs/${runs[0].id}`)
    // Still failing on the fake key: the badge comes back once the run ends.
    await expect(badge).toHaveAccessibleName('2 failed, retry', { timeout: 20_000 })
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
})

test('a waterfall column: an edited input makes its row out of date, and mode out_of_date reruns only it', async () => {
  test.setTimeout(90_000)
  const { sheetId } = await sheetWith('Name,Website\nMaya Chen,stripe.com\nLee Park,acme.com\n')
  const client = await mcpClient(token)
  // One free step: a formula guessing the email from the inputs.
  const run = await call(client, 'waterfall_column', {
    sheet_id: sheetId, column_name: 'Work email', result_type: 'email', estimate_only: false, fresh: true,
    inputs: { full_name: 'Name', domain: 'Website' },
    steps: [{ kind: 'formula', label: 'Guess',
      formula: "{{full_name}}.toLowerCase().replace(' ', '.') + '@' + {{domain}}" }],
  })
  await waitForTerminal(v1, `/api/v1/http-runs/${run.run_id}`)
  expect(await statuses(sheetId, 'Work email')).toEqual(['done', 'done'])

  await edit(sheetId, 1, 'Website', 'acme.io')
  expect(await statuses(sheetId, 'Work email')).toEqual(['done', 'out_of_date'])
  const counts = await (await api.get(`/api/run-controls/sheets/${sheetId}/counts?column=Work%20email`)).json()
  expect(counts).toMatchObject({ kind: 'waterfall', total: 2, empty: 0, outOfDate: 1, failed: 0 })

  const again = await call(client, 'control_run', { run_type: 'waterfall', run_id: run.run_id, action: 'rerun',
    mode: 'out_of_date' })
  expect(again.rows_in_scope).toBe(1)
  await waitForTerminal(v1, `/api/v1/http-runs/${again.run_id}`)
  const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows as
    Array<{ data: Record<string, string> }>
  expect(rows.map(r => r.data['Work email'])).toEqual(['maya.chen@stripe.com', 'lee.park@acme.io'])
  expect(await statuses(sheetId, 'Work email')).toEqual(['done', 'done'])
})

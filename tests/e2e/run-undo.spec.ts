// Over 200 lines: one spec of undoing a run, the four run kinds sharing its receiver, token and helpers.
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, seedSheet, importCsv, BASE } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { Receiver } from './helpers-receiver'
import { freshTreg, mockBilling, rowsOf, startRun, verifiedEmailRun, waitRun } from './helpers-enrich'

// Undo a run: the cells it wrote go back to what they held before it, a cell
// changed since stays, nothing is called or billed again. An HTTP API column
// over REST (a newer run first, then the one before it over MCP), an AI
// column from the column menu (failing fast for free on a fake OpenRouter
// key), a waterfall over MCP and an enrichment on the mock treg over REST.
// Screenshots land in test-results/shots/.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
let token: string

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  token = await makeToken(api, ['read', 'write', 'run'], 'run undo spec')
  v1 = await bearer(token)
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/shots/${name}.png` })
const header = (page: Page, name: string) => page.locator('.ag-header-cell').filter({ hasText: name }).first()
const openMenu = (page: Page, name: string) =>
  header(page, name).locator('.ag-header-cell-text > div').first().click()

async function sheetWith(csv: string): Promise<{ tableId: string; sheetId: string }> {
  const s = await seedSheet(api, 1)
  expect((await importCsv(api, s.sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  return s
}
const edit = async (sheetId: string, rowIndex: number, columnName: string, value: string) =>
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [{ rowIndex, columnName, value }] } }))
    .ok()).toBeTruthy()
const column = async (sheetId: string, name: string) => (await rowsOf(api, sheetId)).map(r => r[name] ?? '')

test('an HTTP API column: REST undoes the newest run, skipping an edited cell; MCP then the run before', async () => {
  test.setTimeout(90_000)
  const { sheetId } = await sheetWith('Name\nAda\nBo\nCy\n')
  // POST: answers aren't cached, so the second run gets the receiver's new answer.
  rx.on('/echo', { status: 200, body: '{"ok":"one"}' })
  const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url('/echo?n={{Name}}'), method: 'POST', master_column_name: 'Call',
    response_mapping: [{ json_path: '$.ok', column_name: 'OK' }],
  } })
  expect(start.status(), await start.text()).toBe(202)
  const first = (await start.json()).run_id as string
  await waitForTerminal(v1, `/api/v1/http-runs/${first}`)
  rx.on('/echo', { status: 200, body: '{"ok":"two"}' })
  const again = await v1.post(`/api/v1/http-runs/${first}/rerun`, { data: { mode: 'all' } })
  expect(again.status(), await again.text()).toBe(202)
  const second = (await again.json()).run_id as string
  await waitForTerminal(v1, `/api/v1/http-runs/${second}`)
  expect(await column(sheetId, 'OK')).toEqual(['two', 'two', 'two'])
  await edit(sheetId, 1, 'OK', 'mine')
  const hits = rx.hitsOn('/echo').length

  const view = await (await v1.get(`/api/v1/http-runs/${second}/undo`)).json()
  expect(view).toMatchObject({ run_id: second, column: 'Call', state: 'kept', rows: 3, can_undo: true })
  const undone = await v1.post(`/api/v1/http-runs/${second}/undo`)
  expect(undone.status(), await undone.text()).toBe(200)
  // Call held "✅ Success" before this run too (back already); OK's two cells go back; row 1's edit stays.
  expect(await undone.json()).toMatchObject({ state: 'undone', restored: 5, skipped: 1, gone: 0 })
  expect(await column(sheetId, 'OK')).toEqual(['one', 'mine', 'one'])
  expect(rx.hitsOn('/echo').length).toBe(hits)
  const twice = await v1.post(`/api/v1/http-runs/${second}/undo`)
  expect(twice.status()).toBe(409)
  expect((await twice.json()).error).toMatch(/already undone/)

  // MCP: the column's newest run that can still be undone is now the first.
  const client = await mcpClient(token)
  const dry = await call(client, 'undo_run', { sheet_id: sheetId, column: 'OK', dry_run: true })
  expect(dry).toMatchObject({ run_id: first, can_undo: true, rows: 3 })
  const out = await call(client, 'undo_run', { sheet_id: sheetId, column: 'OK' })
  expect(out.message).toMatch(/^Undone: 5 cells back as they were before the run; 1 cell changed since stayed/)
  expect(await column(sheetId, 'OK')).toEqual(['', 'mine', ''])
  expect(await column(sheetId, 'Call')).toEqual(['', '', ''])
  expect(await callError(client, 'undo_run', { sheet_id: sheetId, column: 'OK' })).toMatch(/no run that can/)
  const history = await (await v1.get(`/api/v1/sheets/${sheetId}/history`)).json()
  const lines = (history.changes as Array<{ action: string; summary: string }>).filter(c => c.action === 'run_undone')
  expect(lines.map(l => l.summary)).toEqual([
    'Undid the run of "Call": 5 cells back; 1 cell changed since stayed as they were',
    'Undid the run of "Call": 5 cells back; 1 cell changed since stayed as they were',
  ])
})

test('an AI column: "Undo last run" in its menu asks first, then empties what the run filled', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await sheetWith('Name\nAda\nBo\n')
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    const client = await mcpClient(token)
    const ai = await call(client, 'run_ai_column', { sheet_id: sheetId, column_name: 'Blurb',
      prompt: 'Describe /name', model: 'deepseek/deepseek-v4-flash' })
    await waitForTerminal(v1, `/api/v1/ai-runs/${ai.run_id}`)
    expect((await column(sheetId, 'Blurb (Output)')).every(v => v.startsWith('❌'))).toBe(true)

    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await openMenu(page, 'Blurb (Output)')
    await expect(page.getByRole('menu').getByTestId('undo-run')).toHaveText(/Undo last run/)
    await page.waitForTimeout(300)   // the menu's open animation
    await shot(page, 'run-undo-menu')
    await page.getByRole('menu').getByTestId('undo-run').click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'Undo last run' })
    await expect(dialog).toContainText('Undo the run of "Blurb (Output)" from')
    await expect(dialog).toContainText('The cells it filled in 2 rows go back to what they held before it.')
    await expect(dialog).toContainText('Nothing runs again and nothing is billed')
    await page.waitForTimeout(300)
    await shot(page, 'run-undo-confirm')
    await dialog.getByRole('button', { name: 'Undo run' }).click()
    await expect(page.getByText(/^Undone: \d+ cells back as before the run\.$/)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.ag-row[row-index="0"]').first()).not.toContainText('❌', { timeout: 10_000 })
    await page.waitForTimeout(500)
    await shot(page, 'run-undo-done')
    expect(await column(sheetId, 'Blurb (Output)')).toEqual(['', ''])

    // Asked again, the menu says there is nothing left to undo.
    await openMenu(page, 'Blurb (Output)')
    await page.getByRole('menu').getByTestId('undo-run').click()
    await expect(page.getByRole('dialog').filter({ hasText: 'Undo last run' }))
      .toContainText('"Blurb (Output)" has no run that can be undone')
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
})

test('a waterfall: undo_run takes back its result, "Answered by" and step cells', async () => {
  test.setTimeout(90_000)
  const { sheetId } = await sheetWith('Name,Website\nMaya Chen,stripe.com\nLee Park,acme.com\n')
  const client = await mcpClient(token)
  const run = await call(client, 'waterfall_column', {
    sheet_id: sheetId, column_name: 'Work email', result_type: 'email', estimate_only: false, fresh: true,
    inputs: { full_name: 'Name', domain: 'Website' },
    steps: [{ kind: 'formula', label: 'Guess',
      formula: "{{full_name}}.toLowerCase().replace(' ', '.') + '@' + {{domain}}" }],
  })
  await waitForTerminal(v1, `/api/v1/http-runs/${run.run_id}`)
  const before = await rowsOf(api, sheetId)
  expect(before[0]['Work email']).toBe('maya.chen@stripe.com')
  expect(before[0]['Work email (Answered by)']).toBe('Guess')
  const out = await call(client, 'undo_run', { run_type: 'waterfall', run_id: run.run_id })
  expect(out).toMatchObject({ state: 'undone', skipped: 0, gone: 0 })
  const after = await rowsOf(api, sheetId)
  for (const row of after) {
    for (const [name, value] of Object.entries(row)) {
      if (name.startsWith('Work email')) expect(value ?? '', name).toBe('')
    }
  }
  expect(after.map(r => r.Name)).toEqual(['Maya Chen', 'Lee Park'])
})

test('an enrichment: REST undoes it on the mock treg, and nothing is bought again', async () => {
  test.setTimeout(90_000)
  await freshTreg(api)
  const { sheetId } = await sheetWith('Name,Website\nMaya Chen,https://stripe.com\n')
  const runId = await startRun(api, sheetId, verifiedEmailRun({ outputs: [
    { key: 'email', path: '$.output.email', columnName: 'Email' },
  ] }))
  await waitRun(api, runId, ['completed'])
  expect(await column(sheetId, 'Email')).toEqual(['maya.chen@stripe.com'])
  expect(await column(sheetId, 'Work email')).not.toEqual([''])
  const billed = (await mockBilling()).length
  const res = await v1.post(`/api/v1/http-runs/${runId}/undo`)
  expect(res.status(), await res.text()).toBe(200)
  expect(await res.json()).toMatchObject({ state: 'undone', skipped: 0, gone: 0 })
  expect(await column(sheetId, 'Email')).toEqual([''])
  expect(await column(sheetId, 'Work email')).toEqual([''])
  expect((await mockBilling()).length).toBe(billed)
})

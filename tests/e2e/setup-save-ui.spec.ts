import { test, expect, type Page } from '@playwright/test'
import { authedApi, BASE, makeAccessToken, seedSheet } from './helpers'
import { freshTreg, readDb, seedLeadRows, verifiedEmailRun } from './helpers-enrich'
import { call, mcpClient } from './helpers-mcp'

// The edit dialogs' Save (PR 3a of "Change a column's setup without running it"): the AI dialog, the enrichment
// drawer and the waterfall drawer each save the setup they show without running it. The toast says so, the dialog
// closes, no run starts and no cell changes; the run button reads "Save and run ..." while editing.

type Setup = { setup_only: number; status: string; setup: string }
const newest = (sheetId: string, table: 'ai_runs' | 'http_runs'): Setup => readDb(db => db.prepare(
  `SELECT setup_only, status, ${table === 'ai_runs' ? 'prompt' : 'config'} AS setup FROM ${table}
   WHERE sheet_id = ? ORDER BY rowid DESC LIMIT 1`).get(sheetId))
const runCount = (sheetId: string, table: 'ai_runs' | 'http_runs'): number =>
  readDb(db => db.prepare(`SELECT COUNT(*) FROM ${table} WHERE sheet_id = ?`).pluck().get(sheetId))
const cellsOf = (sheetId: string): string[] =>
  readDb(db => db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheetId))

async function openColumnMenu(page: Page, header: string) {
  const cell = page.locator('.ag-header-cell').filter({ hasText: header }).first()
  await expect(cell).toBeVisible({ timeout: 15_000 })
  await cell.scrollIntoViewIfNeeded()
  await cell.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
}

test('AI column: Save keeps the new prompt as the column\'s setup and runs nothing', async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 3)
  const made = await api.post('/api/ai/run', { data: {
    sheetId, columnName: 'Summary', prompt: 'Summarize /val', model: 'openai/gpt-4o-mini', saveOnly: true,
  } })
  expect(made.status()).toBe(200)
  const cells = cellsOf(sheetId)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await openColumnMenu(page, 'Summary (Output)')
  await page.getByText('Edit / Update Instructions').click()
  const prompt = page.locator('#prompt')
  await expect(prompt).toHaveValue('Summarize /val', { timeout: 10_000 })
  await prompt.fill('Describe /val in one word')
  await page.getByTestId('ai-save-setup').click()
  await expect(page.getByText('Setup saved. Nothing ran.')).toBeVisible()
  await expect(prompt).toHaveCount(0)
  expect(newest(sheetId, 'ai_runs')).toMatchObject({ setup_only: 3, status: 'completed',
    setup: 'Describe /val in one word' })
  expect(runCount(sheetId, 'ai_runs')).toBe(2)
  expect(cellsOf(sheetId)).toEqual(cells)

  // Opened again, it shows the saved prompt.
  await openColumnMenu(page, 'Summary (Output)')
  await page.getByText('Edit / Update Instructions').click()
  await expect(prompt).toHaveValue('Describe /val in one word', { timeout: 10_000 })
})

test('enrichment and waterfall columns: Save in the drawer runs nothing', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedLeadRows(api, [
    { Name: 'Maya Chen', Website: 'https://stripe.com' }, { Name: 'Leo Martins', Website: 'notion.so' },
  ])
  const enrich = await api.post(`/api/enrich/sheets/${sheetId}/runs`, { data: verifiedEmailRun({ saveOnly: true }) })
  expect(enrich.status(), await enrich.text()).toBe(200)
  // Its auto-run on, then paused by hand: the drawer's Save keeps it paused (a Save runs nothing).
  const on = await api.put(`/api/autorun/sheets/${sheetId}/columns`, { data: {
    column: 'Work email', enabled: true, dailyCapUsd: 1 } })
  expect(on.status(), await on.text()).toBe(200)
  const paused = await api.post(`/api/autorun/sheets/${sheetId}/pause`, {
    data: { paused: true, column: 'Work email' } })
  expect(paused.status(), await paused.text()).toBe(200)
  const autoRun = () => readDb(db => db.prepare(`SELECT enabled, paused_reason FROM autorun_columns
    WHERE sheet_id = ? AND status_column = ?`).get(sheetId, 'Work email'))
  expect(autoRun()).toEqual({ enabled: 1, paused_reason: 'user' })
  const cells = cellsOf(sheetId)
  const before = runCount(sheetId, 'http_runs')
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)

  await openColumnMenu(page, 'Work email')
  await page.getByRole('menuitem', { name: /Edit Enrichment/ }).click()
  await expect(page.locator('#enrich-column-name')).toHaveValue('Work email', { timeout: 15_000 })
  await expect(page.getByTestId('enrich-run-all')).toContainText('Save and run on')
  const autoRunSaved = page.waitForResponse(r => r.request().method() === 'PUT'
    && r.url().includes(`/autorun/sheets/${sheetId}/columns`))
  await page.getByTestId('enrich-save-setup').click()
  await expect(page.getByText('Setup saved. Nothing ran.')).toBeVisible()
  expect((await autoRunSaved).status()).toBe(200)
  expect(autoRun()).toEqual({ enabled: 1, paused_reason: 'user' })
  await expect(page.locator('#enrich-column-name')).toHaveCount(0)
  expect(runCount(sheetId, 'http_runs')).toBe(before + 1)
  expect(newest(sheetId, 'http_runs')).toMatchObject({ setup_only: 3, status: 'completed' })
  expect(cellsOf(sheetId)).toEqual(cells)

  // A waterfall set up over MCP, saved again from its drawer.
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e setup save ui'))
  await call(client, 'waterfall_column', { sheet_id: sheetId, column_name: 'Email WF', template: 'work_email',
    inputs: { full_name: 'Name', domain: 'Website' }, save_only: true })
  await page.reload()
  await openColumnMenu(page, 'Email WF')
  await page.getByRole('menuitem', { name: /Edit Waterfall/ }).click()
  const save = page.getByTestId('waterfall-save-setup')
  await expect(save).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Save and run', exact: true })).toBeVisible()
  const wfBefore = runCount(sheetId, 'http_runs')
  await save.click()
  await expect(page.getByText('Setup saved. Nothing ran.')).toBeVisible()
  await expect(save).toHaveCount(0)
  expect(runCount(sheetId, 'http_runs')).toBe(wfBefore + 1)
  expect(newest(sheetId, 'http_runs')).toMatchObject({ setup_only: 3, status: 'completed' })
  expect(JSON.parse(newest(sheetId, 'http_runs').setup).waterfall).toBeTruthy()
  expect(cellsOf(sheetId)).toEqual(cells)
})

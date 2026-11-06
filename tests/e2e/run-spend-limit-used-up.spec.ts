// An AI run paused by hand whose spend limit is used up: what it spent and its
// calls cut off before they answered reach the limit, so the server takes a
// resume only with a higher one (services/ai-run-floor.ts), and get_run_status
// and GET /v1/ai-runs/:id say the least it takes (resume_least_usd). In the
// app, Resume asks for it in the "Raise the spend limit" dialog instead of
// failing with a toast that names an API field: the header's Resume (all
// runs) and the AI drawer's own Resume. A paused run whose limit still has
// room resumes as before, with no dialog. The key is fake, so rows fail for
// free; the used-up state is set in the throwaway test DB (a cut-off total
// needs a billed call that broke off).
import { test, expect, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken, assertTestDb } from './helpers'
import { mcpClient, call } from './helpers-mcp'

const FAKE_KEY = 'sk-or-v1-limit-used-up-e2e'
const MODEL = 'openai/gpt-4o-mini'
const TINY = 0.000001

// Paused by hand, with $0.001 of cut-off calls filling its $0.001 limit: a resume needs at least $0.001001.
function usedUpByHand(runId: string, limitUsd = 0.001, cutOffMicro = 1000) {
  const db = new Database(assertTestDb(process.env.DB_PATH))
  try {
    db.pragma('busy_timeout = 5000')
    const r = db.prepare(`UPDATE ai_runs SET pause_reason = NULL, error_message = NULL, spend_limit_usd = ?,
      spend_cut_off_micro = ? WHERE id = ? AND status = 'paused'`).run(limitUsd, cutOffMicro, runId)
    expect(r.changes).toBe(1)
  } finally { db.close() }
}

async function aiStatus(client: Client, runId: string, statuses: string[]) {
  let last: any
  await expect.poll(async () => (last = await call(client, 'get_run_status',
    { run_type: 'ai', run_id: runId, wait_seconds: 2 })).status, { timeout: 60_000 }).toMatch(
    new RegExp(`^(${statuses.join('|')})$`))
  return last
}

// A run that pauses at a tiny limit before any call (so it is paused, with no row run).
async function pausedRun(client: Client, sheetId: string, column: string): Promise<string> {
  const started = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: column, prompt: 'Say hi to /val', model: MODEL, spend_limit_usd: TINY,
  })
  await aiStatus(client, started.run_id, ['paused'])
  return started.run_id
}

async function raiseInDialog(page: Page, column: string) {
  const dialog = page.getByTestId('ai-raise-limit')
  await expect(dialog).toContainText(column)
  await expect(dialog.getByTestId('ai-raise-limit-why')).toHaveText(
    'The run is paused, and its $0.001 spend limit is used up.')
  await expect(dialog.getByTestId('ai-raise-limit-least')).toContainText('It needs at least $0.001001 to go on')
  await dialog.getByLabel('New limit').fill('5')
  await dialog.getByRole('button', { name: 'Raise and resume' }).click()
  await expect(dialog).toBeHidden()
}

test('Resume on a run paused by hand with its limit used up asks for a higher one: the header and the drawer', async ({
  page, context,
}) => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e limit used up')
  const client = await mcpClient(token)
  const est = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Probe', prompt: 'Say hi to /val', model: MODEL, estimate_only: true,
  })
  test.skip(est.pricing_available !== true, "OpenRouter's public price list is unreachable")
  expect((await api.put(`/api/sheets/${sheetId}/default-model`, { data: { model: MODEL } })).ok()).toBeTruthy()
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: FAKE_KEY } })).ok()).toBeTruthy()
  try {
    // One run with its limit used up, one paused by hand with room left.
    const usedUp = await pausedRun(client, sheetId, 'Used')
    usedUpByHand(usedUp)
    const room = await pausedRun(client, sheetId, 'Room')
    usedUpByHand(room, 5, 0)
    const status = await call(client, 'get_run_status', { run_type: 'ai', run_id: usedUp })
    expect(status).toMatchObject({ status: 'paused', spend_limit_usd: 0.001, resume_least_usd: 0.001001 })
    expect(status.pause_reason).toBeUndefined()
    const rest = await (await api.get(`${BASE}/api/v1/ai-runs/${usedUp}`,
      { headers: { Authorization: `Bearer ${token}` } })).json()
    expect(rest.resume_least_usd).toBe(0.001001)

    // The header's Resume: the run with room goes on at once, the used-up one asks; no toast names a field.
    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await page.getByTitle('Resume all runs').click()
    await expect(page.getByTestId('ai-raise-limit')).toBeVisible()
    await expect(page.getByTestId('ai-raise-limit')).not.toContainText('more run')
    const roomDone = await aiStatus(client, room, ['completed', 'failed'])
    expect(roomDone.spend_limit_usd).toBe(5)
    await raiseInDialog(page, 'Used (Output)')
    await expect(page.getByText(/spendLimitUsd|spend_limit_usd/)).toHaveCount(0)
    expect((await aiStatus(client, usedUp, ['completed', 'failed'])).spend_limit_usd).toBe(5)

    // The drawer's own Resume, on a run it started (a tiny limit added on its way to the server).
    await page.route('**/api/ai/run', async route => {
      const body = JSON.parse(route.request().postData() ?? '{}')
      await route.continue({ postData: JSON.stringify({ ...body, spendLimitUsd: TINY }) })
    })
    await page.getByRole('button', { name: 'AI Column', exact: true }).click()
    await page.getByPlaceholder('e.g., Industry Analysis, Sentiment Score').fill('Drawer')
    await page.locator('#prompt').fill('Say hi to /val')
    await page.getByRole('button', { name: /Try on/ }).click()
    await expect(page.getByRole('button', { name: 'Run All Rows' })).toBeEnabled({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Run All Rows' }).click()
    let runId = ''
    await expect.poll(async () => {
      const runs = await (await api.get('/api/ai/runs', { params: { sheetId } })).json()
      const run = runs.find((r: any) => r.column_name === 'Drawer (Output)')
      runId = run?.id ?? ''
      return run ? `${run.status}/${run.pause_reason}` : ''
    }, { timeout: 60_000 }).toBe('paused/spend_limit')
    usedUpByHand(runId)
    if (!(await page.getByRole('dialog').getByRole('button', { name: 'Resume', exact: true }).isVisible())) {
      await page.getByRole('button', { name: 'AI Column', exact: true }).click()
    }
    // The drawer's poll picks the hand pause up (no self-pause notice), then Resume asks.
    await expect(page.getByTestId('run-self-paused')).toBeHidden({ timeout: 30_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Resume', exact: true }).click()
    await raiseInDialog(page, 'Drawer (Output)')
    expect((await aiStatus(client, runId, ['completed', 'failed'])).spend_limit_usd).toBe(5)
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
})

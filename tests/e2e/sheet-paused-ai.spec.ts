import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, makeAccessToken, assertTestDb } from './helpers'
import { mcpClient, call } from './helpers-mcp'
import { expectLine, listed, openSheet, pausedLine, putPause } from './helpers-paused'

// AI runs that paused themselves, on the sheet (components/sheet/PausedRunsNotice.tsx): the line under the
// header names the run's column and says why and what to change, and its Resume carries the run on (at its
// spend limit, through the "Raise the spend limit" dialog). The key is fake, so rows fail for free: five in a
// row pause the run on provider errors. web_engine (OpenRouter refusing the fetch engine Exa) is put in place in
// the test database, since this harness has no OpenRouter of its own to refuse it; so is a run at its access
// token's spend cap, whose words the server works out from the token when read (no row here costs anything).
const FAKE_KEY = 'sk-or-v1-sheet-paused-e2e'
const MODEL = 'openai/gpt-4o-mini'
const BRAKE = /5 rows in a row failed on the provider's side, so the run paused\. Resume once it works again/
// As lib/web-engine-refusal.ts webEngineMessage writes it.
const WEB_ENGINE = 'OpenRouter refused the web fetch engine Exa (403): your workspace limits web fetch engines on '
  + "its Server Tools page and Exa isn't allowed. Runs with a tokens per page or pages per row limit read pages "
  + 'through Exa. Allow Exa there, then resume this run. Or cancel this run first, then run the column again '
  + 'without the two limits. OpenRouter said: engine exa is not allowed for web fetch'
let api: APIRequestContext
let client: Client
const TOKEN = 'sheet paused ai spec'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  api = await authedApi()
  client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], TOKEN))
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: FAKE_KEY } })).ok()).toBeTruthy()
})
test.afterAll(async () => { await api.delete('/api/settings/openrouter-key') })

const statusOf = async (sheetId: string, runId: string) => {
  const r = await listed(api, 'ai', sheetId, runId)
  return r ? `${r.status}/${r.pause_reason ?? ''}` : ''
}
const ended = (sheetId: string, runId: string) =>
  expect.poll(() => statusOf(sheetId, runId), { timeout: 60_000 }).toMatch(/^(completed|failed)\//)
async function start(sheetId: string, column: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: column, prompt: 'Say hi to /val', model: MODEL, concurrency: 1, ...extra,
  })).run_id
}
// Seven rows, one at a time, each refused for the fake key: the fifth pauses the run, two rows still to go.
async function braked(sheetId: string, column: string): Promise<string> {
  const runId = await start(sheetId, column)
  await expect.poll(() => statusOf(sheetId, runId), { timeout: 60_000 }).toBe('paused/provider_errors')
  return runId
}
const resumeLine = (page: Page, runId: string, column: string) =>
  pausedLine(page, runId).getByRole('button', { name: `Resume ${column}` }).click()
function setRun(runId: string, sql: string, ...args: unknown[]) {
  const db = new Database(assertTestDb(process.env.DB_PATH))
  try {
    db.pragma('busy_timeout = 5000')
    expect(db.prepare(sql).run(...args, runId).changes).toBe(1)
  } finally { db.close() }
}

test('provider_errors: rows kept failing; the line says so, and its Resume runs the rows left', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await seedSheet(api, 7)
  const runId = await braked(sheetId, 'Hi')
  await openSheet(page, context, api, tableId)
  await expectLine(page, runId, 'Hi (Output)', BRAKE)
  await resumeLine(page, runId, 'Hi (Output)')
  await ended(sheetId, runId)
  await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
})

test('spend_limit: the line says the limit was reached; its Resume asks for a higher one, then goes on', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await seedSheet(api, 2)
  const est = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Probe', prompt: 'Say hi to /val', model: MODEL, estimate_only: true,
  })
  test.skip(est.pricing_available !== true, "OpenRouter's public price list is unreachable")
  const runId = await start(sheetId, 'Capped', { spend_limit_usd: 0.000001 })
  await expect.poll(() => statusOf(sheetId, runId), { timeout: 60_000 }).toBe('paused/spend_limit')
  await openSheet(page, context, api, tableId)
  await expectLine(page, runId, 'Capped (Output)', /spend limit .*Resume it with a higher limit to go on\./)
  await resumeLine(page, runId, 'Capped (Output)')
  const dialog = page.getByTestId('ai-raise-limit')
  await expect(dialog).toContainText('Capped (Output)')
  await dialog.getByLabel('New limit').fill('5')
  await dialog.getByRole('button', { name: 'Raise and resume' }).click()
  await ended(sheetId, runId)
  expect((await listed(api, 'ai', sheetId, runId))!.spend_limit_usd).toBe(5)
  await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
})

test("web_engine (put in place): the line names OpenRouter's Server Tools page; Resume goes on", async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await seedSheet(api, 7)
  const runId = await braked(sheetId, 'Fetch')
  putPause('ai_runs', runId, 'web_engine', WEB_ENGINE)
  await openSheet(page, context, api, tableId)
  const line = await expectLine(page, runId, 'Fetch (Output)', "limits web fetch engines on its Server Tools page")
  await expect(line).toContainText('Or cancel this run first, then run the column again without the two limits.')
  await resumeLine(page, runId, 'Fetch (Output)')
  await ended(sheetId, runId)
  await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
})

test("token_cap (put in place): the words come from the token's cap as it is now, here and in get_run_status", async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const { tableId, sheetId } = await seedSheet(api, 7)
  const runId = await braked(sheetId, 'Agent')
  const tok = ((await (await api.get('/api/settings/access-tokens')).json()) as Array<any>).find(t => t.name === TOKEN)
  const cap = (usd: number) => api.patch(`/api/settings/access-tokens/${tok.id}`, { data: { spend_cap_usd: usd } })
  expect((await cap(0)).ok()).toBeTruthy()
  putPause('ai_runs', runId, 'token_cap', 'placeholder')
  setRun(runId, 'UPDATE ai_runs SET error_message = NULL, access_token_id = ? WHERE id = ?', tok.id)
  const atCap = `The access token "${TOKEN}" reached its $0.00 spend cap ($0.00 spent).`
  const status = await call(client, 'get_run_status', { run_type: 'ai', run_id: runId })
  expect(status.pause_message).toContain(atCap)
  expect((await listed(api, 'ai', sheetId, runId))!.pause_message).toBe(status.pause_message)
  await openSheet(page, context, api, tableId)
  await expectLine(page, runId, 'Agent (Output)', `${atCap} The cap is for the token's whole life`)
  // Raised in Settings: the words say so (read again, not kept), and Resume goes on.
  expect((await cap(1)).ok()).toBeTruthy()
  await page.reload()
  await expectLine(page, runId, 'Agent (Output)', "Its access token's spend cap was raised: resume the run to go on.")
  expect((await call(client, 'get_run_status', { run_type: 'ai', run_id: runId })).pause_message)
    .toBe("Its access token's spend cap was raised: resume the run to go on.")
  await resumeLine(page, runId, 'Agent (Output)')
  await ended(sheetId, runId)
  await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
  await api.patch(`/api/settings/access-tokens/${tok.id}`, { data: { spend_cap_usd: null } })
})

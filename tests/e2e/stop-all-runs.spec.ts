import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, BASE, makeAccessToken } from './helpers'
import { mockTreg } from './helpers-treg'
import { mcpClient, call, callError } from './helpers-mcp'
import { sheetWith } from './helpers-setups'
import {
  expectSettledBilledOnce, freshTreg, rowsOf, runIdsOf, startRun, verifiedEmailRun, waitRun,
} from './helpers-enrich'
import { autorunOf, autorunRuns, seedViaWebhook, setAutorun, sleep, waitAutorunActive } from './helpers-autorun'

// Stopping every run on a sheet at once (services/sheet-runs-stop.ts). REST:
// get_sheet lists a paused HTTP run, the stop ends it and names the auto-run
// still on; a read token can't. MCP: an auto-run's enrichment batch in flight
// is listed and stopped with cancel_all, its auto-run pauses and new rows don't
// set it off; the call already sent finishes and is billed once. App: "Stop
// all" shows while a setup is paused between steps, then with a run too; one
// click stops both and the toast says what it did.

const COL = 'Work email'
const shots = process.env.E2E_SHOTS
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }) }

// An HTTP run started on the sheet, then paused: active whatever the worker does next.
async function pausedHttpRun(api: APIRequestContext, sheetId: string, column: string, input: string) {
  const start = await api.post('/api/http/run', { data: { sheetId, masterColumnName: column, config: {
    requestConfig: { method: 'GET', url: `https://example.com/{{${input}}}`, headers: {}, body: '' },
    responseMapping: [{ columnName: `${column} out`, jsonPath: '$.x' }],
  } } })
  expect(start.ok(), await start.text()).toBeTruthy()
  const runId = (await start.json()).runId as string
  expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'pause' } })).ok()).toBeTruthy()
  return runId
}

test.describe.configure({ mode: 'serial' })
test.afterEach(async () => { await mockTreg.set({ delayMs: 0 }) })

test('REST and MCP stop every run on a sheet; auto-run pauses only where its batch stopped', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId, deliver } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun()), ['completed'])
  await setAutorun(api, sheetId, { column: COL, enabled: true, dailyCapUsd: 1 })
  const lookup = await pausedHttpRun(api, sheetId, 'Lookup', 'Name')

  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'stop-all')
  const auth = { Authorization: `Bearer ${token}` }
  const sheet = await (await api.get(`${BASE}/api/v1/sheets/${sheetId}`, { headers: auth })).json()
  expect(sheet.active_runs).toEqual([{ run_type: 'http', run_id: lookup, status: 'paused', column: 'Lookup',
    auto_run: false }])
  expect(sheet.active_setup_runs).toEqual([])

  const readOnly = await makeAccessToken(api, ['read'], 'stop-all read')
  const refused = await api.post(`${BASE}/api/v1/sheets/${sheetId}/runs/stop`,
    { headers: { Authorization: `Bearer ${readOnly}` } })
  expect(refused.status()).toBe(403)
  expect((await api.post(`${BASE}/api/v1/sheets/nope/runs/stop`, { headers: auth })).status()).toBe(404)

  const stop = await api.post(`${BASE}/api/v1/sheets/${sheetId}/runs/stop`, { headers: auth })
  expect(stop.status()).toBe(200)
  const stopped = await stop.json()
  expect(stopped.stopped_runs).toEqual([{ run_type: 'http', run_id: lookup, column: 'Lookup', auto_run: false }])
  expect(stopped.auto_run_on).toEqual([COL])
  expect(stopped.auto_run_paused).toEqual([])
  expect(stopped.message).toBe('Stopped 1 run: "Lookup". Calls already sent finish, and paid ones are still '
    + `billed. Auto-run is still on for "${COL}", so new rows will start runs there again.`)
  await expect.poll(async () => (await rowsOf(api, sheetId)).some(r => (r.Lookup ?? '').startsWith('⏳')))
    .toBe(false)

  // An auto-run batch in flight (the mock answers slowly).
  const client = await mcpClient(token, 'stop-all')
  await mockTreg.set({ delayMs: 2500 })
  await deliver({ Name: 'Leo Martins', Website: 'notion.so' })
  const batch = await waitAutorunActive(sheetId)
  const listed = (await call(client, 'get_sheet', { sheet_id: sheetId })).active_runs
  expect(listed).toEqual([{ run_type: 'enrichment', run_id: batch.id, status: expect.any(String), column: COL,
    auto_run: true }])

  expect(await callError(client, 'control_run', { action: 'cancel_all' })).toMatch(/needs sheet_id/)
  expect(await callError(client, 'control_run', { action: 'cancel_all', sheet_id: sheetId, run_id: batch.id }))
    .toMatch(/takes only sheet_id/)
  expect(await callError(client, 'control_run', { action: 'pause', sheet_id: sheetId }))
    .toMatch(/cancel_all only/)
  expect(await callError(client, 'control_run', { action: 'pause' })).toMatch(/Pass run_type and run_id/)

  const out = await call(client, 'control_run', { action: 'cancel_all', sheet_id: sheetId })
  expect(out.stopped_runs).toEqual([{ run_type: 'enrichment', run_id: batch.id, column: COL, auto_run: true }])
  expect(out.auto_run_paused).toEqual([COL])
  expect(out.auto_run_on).toEqual([])
  expect(out.message).toContain(`Auto-run on "${COL}" is paused until you resume it.`)
  expect((await autorunOf(api, sheetId, COL)).pausedReason).toBe('user')
  // Its call in flight finishes and is billed once; new rows don't set the paused auto-run off.
  await expectSettledBilledOnce(runIdsOf(sheetId))
  await mockTreg.set({ delayMs: 0 })
  await deliver({ Name: 'Ada Lovelace', Website: 'figma.com' })
  await sleep(2500)
  expect(autorunRuns(sheetId).filter(r => ['pending', 'running', 'paused'].includes(r.status))).toEqual([])
  const again = await call(client, 'control_run', { action: 'cancel_all', sheet_id: sheetId })
  expect(again.message).toBe('Nothing was running on this sheet.')
  await client.close()
  await api.dispose()
})

test('Stop all in the app: shown for a paused setup and a run, one click stops both', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'stop-all app'))
  const a = await sheetWith(api, null, [{ Website: 'acme.com' }])
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Label', formula: '{{Domain}} + "!"' })
  const setup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Two steps', columns: ['Label'] })
  const b = await sheetWith(api, a.tableId, [{ Website: 'one.com' }, { Website: 'two.com' }, { Website: 'six.com' }])
  const run = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, estimate_only: false }))
    .setup_run
  expect((await call(client, 'control_setup_run', { setup_run_id: run.id, action: 'pause' })).status).toBe('paused')

  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${b.tableId}/${b.sheetId}`)
  const stopAll = page.getByRole('button', { name: 'Stop all' })
  await expect(page.getByTestId('setup-run-chip')).toBeVisible({ timeout: 15_000 })
  // Only the setup: Stop all, with nothing to pause or resume.
  await expect(stopAll).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
  await shot(page, 'stop-all-setup-only')

  const lookup = await pausedHttpRun(api, b.sheetId, 'Lookup', 'Website')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(stopAll).toBeVisible()
  await shot(page, 'stop-all-run-and-setup')

  await stopAll.click()
  const toast = page.getByRole('status')
    .filter({ hasText: 'Stopped 1 run: "Lookup". Stopped the setup "Two steps".' })
  await expect(toast).toBeVisible()
  await sleep(400)
  await shot(page, 'stop-all-toast')
  await expect(stopAll).toHaveCount(0)
  await expect(page.getByTestId('setup-run-chip')).toHaveCount(0, { timeout: 10_000 })
  expect((await call(client, 'get_setup_run', { setup_run_id: run.id })).status).toBe('cancelled')
  expect((await (await api.get(`/api/http/jobs/${lookup}`)).json()).status).toBe('cancelled')
  await client.close()
  await api.dispose()
})

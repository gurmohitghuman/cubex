import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { call, mcpClient } from './helpers-mcp'
import { rowsOf, seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'
import { listed, openSheet } from './helpers-paused'

// A waterfall whose lookup step reads another sheet's column while a run there still fills it
// (components/sheet/WaitingRunsNotice.tsx): the rows that match wait, and the waterfall says which column, on
// which sheet, and how many rows wait. Its link opens that sheet with the filling run's column in view. Once
// that run is done, the rows answer with what it wrote, and the line goes.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
let mcp: Client

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  const token = await makeToken(api, ['read', 'write', 'run'], 'sheet waiting lookup spec')
  v1 = await bearer(token)
  mcp = await mcpClient(token)
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose(); await api?.dispose() })

const LEADS = 'Name,Website\nMaya Chen,stripe.com\nOwen Park,parkco.example\nNo One,nowhere.example'
const CRM = 'Domain\nstripe.com\nparkco.example'
const line = (page: Page, runId: string) => page.locator(`[data-testid="waiting-run"][data-run-id="${runId}"]`)
const header = (page: Page, name: string) => page.locator('.ag-header-cell')
  .filter({ has: page.locator('.ag-header-cell-text', { hasText: new RegExp(`(^|\\s)${name}$`) }) })

test("a lookup step waiting on another sheet's run says where; its link opens that sheet", async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const leads = await seedCsv(api, LEADS)
  const t = await (await api.post('/api/tables', { data: { name: `CRM ${Date.now()}` } })).json()
  const crmId = t.sheets[0].id as string
  expect((await api.patch(`/api/tables/${t.id}/sheets/${crmId}`, { data: { name: 'Contacts' } })).ok()).toBeTruthy()
  expect((await importCsv(api, crmId, CRM, { replaceData: true, filename: 'crm.csv' })).ok()).toBeTruthy()

  // A run on Contacts fills Email, then runs again with its calls held: Email reads ⏳ there meanwhile. POST,
  // so the second time calls again (a GET's answer is kept a while and reused).
  rx.on('/crm', { status: 200, body: '{"email":"old@crm.example"}' })
  const started = await v1.post(`/api/v1/sheets/${crmId}/http-runs`, { data: {
    url: rx.url('/crm?d={{Domain}}'), method: 'POST', body: '{}', master_column_name: 'Refresh', batch_size: 1,
    response_mapping: [{ json_path: '$.email', column_name: 'Email' }],
  } })
  expect(started.status(), await started.text()).toBe(202)
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${(await started.json()).run_id}`)).status).toBe('completed')
  rx.on('/crm', { status: 200, body: '{"email":"fresh@crm.example"}' })
  const releaseCrm = rx.holdPath('/crm')
  const again = await v1.post(`/api/v1/http-runs/${(await started.json()).run_id}/rerun`, { data: { mode: 'all' } })
  expect(again.status(), await again.text()).toBe(202)
  const crmRun = (await again.json()).run_id as string
  await rx.waitFor('/crm', 3)

  const wf = await call(mcp, 'waterfall_column', {
    sheet_id: leads.sheetId, column_name: 'Work email', result_type: 'email',
    inputs: { full_name: 'Name', domain: 'Website' },
    steps: [{ kind: 'lookup', other_sheet_id: crmId, match_column: 'Domain', input: 'domain', return_column: 'Email' }],
    estimate_only: false,
  })
  const said = 'Waits for "Email" on sheet "Contacts", which a run there is still filling: 2 rows wait.'
  const waitingOf = async () =>
    (await call(mcp, 'get_run_status', { run_type: 'waterfall', run_id: wf.run_id })).waiting
  await expect.poll(async () => (await waitingOf())?.message, { timeout: 30_000 }).toBe(said)
  const waiting = await waitingOf()
  expect(waiting).toMatchObject({
    column: 'Email', sheet_id: crmId, sheet_name: 'Contacts', table_id: t.id, rows_waiting: 2, parked: false,
    held_by: { run_type: 'http', run_id: crmRun, column_name: 'Refresh', status: 'running' },
  })
  expect((await listed(api, 'http', leads.sheetId, wf.run_id))!.waiting).toEqual(waiting)

  // The app: the line on the leads sheet, and its link to Contacts with the Refresh column in view.
  await openSheet(page, context, api, leads.tableId)
  const l = line(page, wf.run_id)
  await expect(l).toContainText(`Work email ${said}`, { timeout: 15_000 })
  await page.screenshot({ path: 'test-results/shots/waiting-runs-lookup.png' })
  await l.getByRole('button', { name: 'Go to "Refresh" on Contacts' }).click()
  await expect(page).toHaveURL(new RegExp(`/table/${t.id}/${crmId}$`), { timeout: 10_000 })
  await expect(header(page, 'Refresh')).toBeInViewport({ timeout: 15_000 })

  // Once that run is done, the waiting rows answer with what it wrote; the one with no match had none.
  releaseCrm()
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${crmRun}`)).status).toBe('completed')
  await expect.poll(async () =>
    (await call(mcp, 'get_run_status', { run_type: 'waterfall', run_id: wf.run_id })).status,
  { timeout: 30_000 }).toBe('completed')
  expect((await rowsOf(api, leads.sheetId)).map(r => r['Work email']))
    .toEqual(['fresh@crm.example', 'fresh@crm.example', '⏭️ Not found'])
  expect((await listed(api, 'http', leads.sheetId, wf.run_id))!.waiting).toBeUndefined()
})

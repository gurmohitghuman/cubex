import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { call, mcpClient } from './helpers-mcp'
import { seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'
import { listed, openSheet } from './helpers-paused'

// Runs whose rows wait for a column another run is still filling (components/sheet/WaitingRunsNotice.tsx), on
// the sheet, over /api/v1 and over MCP: the column, the run that holds it and what that run is doing, how many
// rows wait. The line's link scrolls to the holder's column and opens a waterfall's drawer. While the holder is
// paused, the waiting run gives its job slot back and says so; resumed, both finish and the line goes. More
// waiting runs than the notice lists: 3 lines, then how many more.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
let mcp: Client
const OK = { status: 200, body: '{"ok":"up"}' }
const COLUMN = 'Work email'
const CSV = 'Name,Website\nMaya Chen,stripe.com\nOwen Park,parkco.example\nAda Lane,ada.example'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  const token = await makeToken(api, ['read', 'write', 'run'], 'sheet waiting runs spec')
  v1 = await bearer(token)
  mcp = await mcpClient(token)
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose(); await api?.dispose() })

const notice = (page: Page) => page.getByTestId('waiting-runs-notice')
const line = (page: Page, runId: string) => page.locator(`[data-testid="waiting-run"][data-run-id="${runId}"]`)
const header = (page: Page, name: string) => page.locator('.ag-header-cell')
  .filter({ has: page.locator('.ag-header-cell-text', { hasText: new RegExp(`(^|\\s)${name}$`) }) })
const control = async (runId: string, action: 'pause' | 'resume' | 'cancel') =>
  expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action } })).ok()).toBeTruthy()
const summary = async (runId: string) => (await v1.get(`/api/v1/http-runs/${runId}`)).json()
const saying = (runId: string, words: string, timeout = 20_000) =>
  expect.poll(async () => (await summary(runId)).waiting?.message, { timeout }).toBe(words)

// An HTTP API run, one row at a time, its calls on `path` (one per row: the name makes each its own), mapping
// `$.ok` into `<column> OK` unless given a mapping. A run sent again uses POST: a GET's answer is kept a while
// and reused, so it wouldn't call again.
async function httpRun(sheetId: string, path: string, column: string, reads: string, mapping?: object[]) {
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url(`${path}?v={{${reads}}}&n={{Name}}`), master_column_name: column, batch_size: 1,
    ...(mapping ? { method: 'POST', body: '{}' } : {}),
    response_mapping: mapping ?? [{ json_path: '$.ok', column_name: `${column} OK` }],
  } })
  expect(res.status(), await res.text()).toBe(202)
  return (await res.json()).run_id as string
}

// A waterfall filling Work email from one HTTP step on `path`.
async function waterfall(sheetId: string, path: string): Promise<string> {
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: {
    columnName: COLUMN, resultType: 'email', fresh: true,
    inputs: [
      { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
      { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
    ],
    steps: [{ label: 'Own API', choices: { kind: 'http', method: 'GET', url: rx.url(`${path}?d={{domain}}`, 'wf'),
      valuePath: '$.email' } }],
  } })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).runId
}
const waterfallStatus = async (runId: string) => {
  const s = await (await api.get(`/api/waterfall/runs/${runId}`)).json()
  return s.starting ? '' : s.status
}

test('a run waiting on a waterfall says so in the app, /api/v1 and MCP; paused, it gives its slot back', async ({
  page, context,
}) => {
  test.setTimeout(180_000)
  rx.on('/w-find', { status: 200, body: '{"email":"own@example.com"}' })
  rx.on('/w-read', OK)
  const { tableId, sheetId } = await seedCsv(api, CSV)
  // Columns between, so the link has somewhere to scroll to.
  for (let i = 1; i <= 8; i++) {
    expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: `Wide ${i}` } })).ok())
      .toBeTruthy()
  }
  const first = await waterfall(sheetId, '/w-find')
  await expect.poll(() => waterfallStatus(first), { timeout: 30_000 }).toBe('completed')

  // The reader's first call is held, so it's still going when the waterfall runs again over every row.
  const releaseRead = rx.holdPath('/w-read')
  const readerId = await httpRun(sheetId, '/w-read', 'Read', COLUMN)
  await rx.waitFor('/w-read', 1)
  const releaseFind = rx.holdPath('/w-find')
  const finds = rx.hitsOn('/w-find').length
  const again = await api.post(`/api/waterfall/sheets/${sheetId}/reruns`, { data: { column: COLUMN, status: 'any' } })
  expect(again.ok(), await again.text()).toBeTruthy()
  const holder = (await again.json()).started.runId as string
  await rx.waitFor('/w-find', finds + 1)
  releaseRead()

  const filling = 'Waits for "Work email", which another run is still filling: 2 rows wait.'
  await saying(readerId, filling)
  const waiting = (await summary(readerId)).waiting
  expect(waiting).toMatchObject({
    column: COLUMN, rows_waiting: 2, parked: false,
    held_by: { run_type: 'waterfall', run_id: holder, column_name: COLUMN, status: 'running' },
  })
  expect(waiting.sheet_id).toBeUndefined()
  expect((await call(mcp, 'get_run_status', { run_type: 'http', run_id: readerId })).waiting).toEqual(waiting)
  expect((await listed(api, 'http', sheetId, readerId))!.waiting).toEqual(waiting)

  // The app: the line, and its link to the waterfall's column and drawer.
  await page.setViewportSize({ width: 1000, height: 800 })
  await openSheet(page, context, api, tableId)
  const l = line(page, readerId)
  await expect(l).toContainText(`Read ${filling}`, { timeout: 15_000 })
  await expect(l).toHaveAttribute('data-holder-id', holder)
  await expect(header(page, COLUMN)).not.toBeInViewport()
  await page.screenshot({ path: 'test-results/shots/waiting-runs-notice.png' })
  await l.getByRole('button', { name: `Go to "${COLUMN}"` }).click()
  await expect(page.getByTestId('waterfall-drawer')).toBeVisible({ timeout: 10_000 })
  await expect(header(page, COLUMN)).toBeInViewport({ timeout: 10_000 })
  await page.keyboard.press('Escape')

  // Paused, the waterfall sends the reader back to the queue: it says so, the app too.
  await control(holder, 'pause')
  const paused = 'Waits for "Work email", whose run is paused: resume or stop that run. 2 rows wait. '
    + 'It gave its job slot back meanwhile.'
  await saying(readerId, paused)
  const parked = await listed(api, 'http', sheetId, readerId)
  expect(parked).toMatchObject({ status: 'pending', waiting: { parked: true, since: waiting.since } })
  expect(parked!.waiting.held_by.status).toBe('paused')
  await expect(l).toContainText(paused, { timeout: 15_000 })

  // Resumed, both finish, the line goes, and no row was sent the waterfall's ⏳.
  await control(holder, 'resume')
  releaseFind()
  await expect.poll(() => waterfallStatus(holder), { timeout: 30_000 }).toBe('completed')
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${readerId}`, 90_000)).status).toBe('completed')
  await expect(notice(page)).toBeHidden({ timeout: 20_000 })
  expect((await listed(api, 'http', sheetId, readerId))!.waiting).toBeUndefined()
  expect(rx.hitsOn('/w-read').map(h => h.query.get('v'))).toEqual(Array(3).fill('own@example.com'))
})

test('more waiting runs than the notice lists: 3 lines, then how many more', async ({ page, context }) => {
  test.setTimeout(150_000)
  rx.on('/b-fit', { status: 200, body: '{"fit":"yes"}' })
  rx.on('/b-read', OK)
  const { tableId, sheetId } = await seedCsv(api, 'Name\nP0\nP1\nP2')
  const fit = await httpRun(sheetId, '/b-fit', 'Fit check', 'Name', [{ json_path: '$.fit', column_name: 'Fit' }])
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${fit}`)).status).toBe('completed')

  // Four readers of Fit, each with its first call held; then Fit runs again and pauses on its first call.
  const releaseRead = rx.holdPath('/b-read')
  const readers: string[] = []
  for (const c of ['R1', 'R2', 'R3', 'R4']) readers.push(await httpRun(sheetId, '/b-read', c, 'Fit'))
  await rx.waitFor('/b-read', 4)
  const releaseFit = rx.holdPath('/b-fit')
  const fits = rx.hitsOn('/b-fit').length
  const rerun = await v1.post(`/api/v1/http-runs/${fit}/rerun`, { data: { mode: 'all' } })
  expect(rerun.status(), await rerun.text()).toBe(202)
  const holder = (await rerun.json()).run_id as string
  releaseRead()
  await rx.waitFor('/b-fit', fits + 1, 30_000)
  await control(holder, 'pause')
  const paused = 'Waits for "Fit", whose run is paused: resume or stop that run. 2 rows wait. '
    + 'It gave its job slot back meanwhile.'
  for (const r of readers) await saying(r, paused, 45_000)

  await openSheet(page, context, api, tableId)
  await expect(notice(page).getByTestId('waiting-run')).toHaveCount(3, { timeout: 15_000 })
  await expect(page.getByTestId('waiting-runs-more')).toHaveText('And 1 more waiting run.')
  await expect(notice(page).getByRole('button', { name: 'Go to "Fit check"' })).toHaveCount(3)
  await page.screenshot({ path: 'test-results/shots/waiting-runs-bound.png' })

  // Stopped, they wait for nothing: the notice goes.
  for (const r of readers) await control(r, 'cancel')
  await control(holder, 'cancel')
  releaseFit()
  await expect(notice(page)).toBeHidden({ timeout: 20_000 })
})

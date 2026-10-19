import { test, expect, APIRequestContext, Page } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, BASE, importCsv } from './helpers'
import { makeToken } from './api-v1-run-helpers'
import { call, mcpClient } from './helpers-mcp'
import { rowsOf, seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'
import { choose, openColumnType } from './helpers-ui'

// Lookup steps: a free first step that takes a work email from another sheet
// (a CRM list) where the lead's domain matches, so only the rows it can't
// answer reach the paid or slower steps after it. Over MCP: priced at $0,
// named after the sheet, described in snake_case, shown in get_sheet; a rename
// in the CRM sheet is followed, a deleted column refused. In the drawer: the
// step set up from its pickers, run, and the answers in the sheet.
const rx = new Receiver()
let api: APIRequestContext
let mcp: Client

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  mcp = await mcpClient(await makeToken(api, ['read', 'write', 'run'], 'waterfall lookup spec'))
  rx.on('/fallback', { status: 200, body: JSON.stringify({ email: 'found@nowhere.example' }) })
})
test.afterAll(async () => { await rx.stop(); await api?.dispose() })

const LEADS = 'Name,Website\nMaya Chen,stripe.com\nOwen Park,PARKCO.example\nNo One,nowhere.example'
const CRM = 'Domain,Email\nstripe.com,maya@stripe.com\nparkco.example,owen@parkco.example\nstripe.com,second@stripe.com'

// Leads in one table, a "Contacts" sheet in another.
async function seed(): Promise<{ tableId: string; sheetId: string; crmId: string }> {
  const leads = await seedCsv(api, LEADS)
  const t = await (await api.post('/api/tables', { data: { name: `CRM ${Date.now()}` } })).json()
  const crmId = t.sheets[0].id as string
  expect((await api.patch(`/api/tables/${t.id}/sheets/${crmId}`, { data: { name: 'Contacts' } })).ok()).toBeTruthy()
  expect((await importCsv(api, crmId, CRM, { replaceData: true, filename: 'crm.csv' })).ok()).toBeTruthy()
  return { ...leads, crmId }
}

async function waitDone(runId: string) {
  for (let i = 0; i < 60; i++) {
    const s = await call(mcp, 'get_run_status', { run_type: 'waterfall', run_id: runId, wait_seconds: 2 })
    if (['completed', 'failed', 'cancelled', 'paused'].includes(s.status)) return s
  }
  throw new Error(`run ${runId} didn't finish`)
}

test('MCP: a free lookup first, the API only for rows it misses; renames followed', async () => {
  const { sheetId, crmId } = await seed()
  const hitsBefore = rx.hitsOn('/fallback').length
  const args = (extra: Record<string, unknown> = {}) => ({
    sheet_id: sheetId, column_name: 'Work email', result_type: 'email',
    inputs: { full_name: 'Name', domain: 'Website' },
    steps: [
      { kind: 'lookup', other_sheet_id: crmId, match_column: 'Domain', input: 'domain', return_column: 'Email' },
      { kind: 'http', label: 'Own API', url: rx.url('/fallback?d={{domain}}', 'lookup'), value_path: '$.email' },
    ],
    ...extra,
  })
  const est = await call(mcp, 'waterfall_column', args())
  expect(est.steps[0]).toMatchObject({ label: 'Contacts', kind: 'lookup', max_usd: 0 })
  const started = await call(mcp, 'waterfall_column', args({ estimate_only: false }))
  expect((await waitDone(started.run_id)).status).toBe('completed')
  const rows = await rowsOf(api, sheetId)
  // The first matching row, top first; capital letters don't matter.
  expect(rows.map(r => [r['Work email'], r['Work email (Answered by)']])).toEqual([
    ['maya@stripe.com', 'Contacts'], ['owen@parkco.example', 'Contacts'], ['found@nowhere.example', 'Own API'],
  ])
  expect(rx.hitsOn('/fallback').length - hitsBefore).toBe(1)
  const res = await call(mcp, 'get_run_results',
    { run_type: 'waterfall', run_id: started.run_id, status_filter: 'all' })
  const trace = res.results.find((r: { row_index: number }) => r.row_index === 2).trace
  expect(trace.map((t: { kind: string; outcome: string }) => [t.kind, t.outcome]))
    .toEqual([['lookup', 'not_found'], ['http', 'answered']])

  // get_sheet and describe show the step with the sheet it looks in.
  const details = (await call(mcp, 'get_sheet', { sheet_id: sheetId })).column_details
  const answer = details.find((d: { name: string }) => d.name === 'Work email')
  expect(answer.fill.steps[0]).toMatchObject({ kind: 'lookup', other_sheet: 'Contacts', match_column: 'Domain' })

  // A rename in the CRM sheet is followed: the setup reads the new name and a rerun still answers.
  await call(mcp, 'rename_column', { sheet_id: crmId, column: 'Email', new_name: 'Work Email' })
  const setup = await call(mcp, 'waterfall_column',
    { action: 'describe', sheet_id: sheetId, column_name: 'Work email' })
  expect(setup.steps[0]).toMatchObject({ kind: 'lookup', other_sheet_id: crmId, return_column: 'Work Email' })
  const again = await call(mcp, 'waterfall_column',
    { sheet_id: sheetId, column_name: 'Work email', add_to_column: true, rows: 'any', estimate_only: false })
  expect((await waitDone(again.run_id)).status).toBe('completed')
  expect((await rowsOf(api, sheetId))[0]['Work email']).toBe('maya@stripe.com')

  // A column it reads deleted there: the waterfall is refused until it's edited.
  await call(mcp, 'delete_column', { sheet_id: crmId, column: 'Domain' })
  const refused = await mcp.callTool({ name: 'waterfall_column', arguments:
    { sheet_id: sheetId, column_name: 'Work email', add_to_column: true, rows: 'any' } }) as
    { isError?: boolean; content?: Array<{ text?: string }> }
  expect(refused.isError).toBeTruthy()
  expect(JSON.parse(refused.content?.[0]?.text ?? '{}').error).toContain('"Domain" isn\'t a column of "Contacts"')
})

const drawer = (page: Page) => page.getByTestId('waterfall-drawer')

test('the drawer: a lookup step set up from its pickers, then run', async ({ page, context }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const { tableId, sheetId } = await seed()
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await openColumnType(page, 'Waterfall')
  await drawer(page).getByTestId('waterfall-type-email').click()
  await drawer(page).getByRole('button', { name: 'Lookup' }).click()
  const step = drawer(page).getByTestId('waterfall-lookup-step')
  await choose(step.getByTestId('wf-lookup-sheet'), { label: 'Contacts' })
  await choose(step.getByTestId('wf-lookup-match-column'), 'Domain')
  await choose(step.getByTestId('wf-lookup-input'), 'domain')
  await choose(step.getByTestId('wf-lookup-return-column'), 'Email')
  await expect(drawer(page).getByTestId('waterfall-step').first()).toContainText('Email from Contacts')
  await expect(drawer(page).getByTestId('waterfall-estimate')).toContainText('3 rows', { timeout: 15_000 })
  await page.screenshot({ path: 'test-results/shots/waterfall-lookup-step.png', fullPage: true })

  await drawer(page).getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  await expect(drawer(page).getByTestId('waterfall-run'))
    .toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
  const rows = await rowsOf(api, sheetId)
  expect(rows.map(r => r['Work email'])).toEqual(['maya@stripe.com', 'owen@parkco.example', '⏭️ Not found'])
  expect(rows[0]['Work email (Answered by)']).toBe('Contacts')
})

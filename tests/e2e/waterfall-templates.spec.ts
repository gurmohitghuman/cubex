import { test, expect, APIRequestContext, Page } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, BASE } from './helpers'
import { makeToken } from './api-v1-run-helpers'
import { call, mcpClient } from './helpers-mcp'
import { callEveryRow, freshTreg, rowsOf, seedCsv } from './helpers-enrich'

// Starter waterfalls. In the drawer, "Work email from name + domain" sets up
// treg's finder then a first.last@domain guess checked by treg's verify, with
// the inputs matched to the columns by name; run, the finder answers one row
// and the checked guess the other (the mock finder misses quietco.example).
// Agents pass `template` to waterfall_column and map the inputs themselves.
let api: APIRequestContext
let mcp: Client
const drawer = (page: Page) => page.getByTestId('waterfall-drawer')

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => {
  api = await authedApi()
  mcp = await mcpClient(await makeToken(api, ['read', 'write', 'run'], 'waterfall templates spec'))
})
test.afterAll(async () => { await api?.dispose() })

test('the drawer: work email from name + domain, from its template', async ({ page, context }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await freshTreg(api, { findMisses: { quietco: 99 } })
  const { tableId, sheetId } = await seedCsv(api,
    'Name,Website\nMaya Chen,stripe.com\nAda Byron,https://www.quietco.example')
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Waterfall', exact: true }).click()
  await expect(drawer(page).getByTestId('waterfall-templates')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(400)   // the drawer's slide-in, for the screenshot
  await page.screenshot({ path: 'test-results/shots/waterfall-templates.png', fullPage: true })
  await drawer(page).getByTestId('waterfall-template-work_email').click()
  await expect(drawer(page).getByLabel('Full name', { exact: true })).toHaveValue('c:Name')
  await expect(drawer(page).getByLabel('Company domain', { exact: true })).toHaveValue('c:Website')
  const steps = drawer(page).getByTestId('waterfall-step')
  await expect(steps).toHaveCount(2)
  await expect(steps.nth(1)).toContainText('Name guess')
  // An input a step reads stays; one none reads can go.
  await expect(drawer(page).getByLabel('Remove First name')).toBeDisabled()
  await expect(drawer(page).getByLabel('Remove Company name')).toBeEnabled()
  await expect(drawer(page).getByTestId('waterfall-estimate')).toContainText('a row on average', { timeout: 15_000 })
  await page.screenshot({ path: 'test-results/shots/waterfall-template-setup.png', fullPage: true })

  await drawer(page).getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  await expect(drawer(page).getByTestId('waterfall-run'))
    .toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
  const rows = await rowsOf(api, sheetId)
  expect(rows.map(r => r['Work email'])).toEqual(['maya.chen@stripe.com', 'ada.byron@quietco.example'])
  expect(rows[1]['Work email (Answered by)']).toBe('Name guess')
})

test('agents: a template gives the result type and steps; the inputs are theirs to map', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, 'Name,Website\nMaya Chen,stripe.com')
  const est = await call(mcp, 'waterfall_column', { sheet_id: sheetId, column_name: 'Mobile', template: 'mobile_phone',
    inputs: { full_name: 'Name', domain: 'Website' } })
  expect(est.estimate_only).toBe(true)
  expect(est.result_type).toBe('Phone')
  expect(est.steps).toHaveLength(1)
  expect(est.steps[0].kind).toBe('enrichment')
  const email = await call(mcp, 'waterfall_column', { sheet_id: sheetId, column_name: 'Work email',
    template: 'work_email', inputs: { full_name: 'Name', domain: 'Website' } })
  expect(email.steps.map((s: { label: string }) => s.label)).toContain('Name guess')
  const refused = async (a: Record<string, unknown>) => {
    const r = await mcp.callTool({ name: 'waterfall_column', arguments: { sheet_id: sheetId, ...a } }) as
      { isError?: boolean; content?: Array<{ text?: string }> }
    expect(r.isError).toBeTruthy()
    return r.content?.map(c => c.text ?? '').join(' ') ?? ''
  }
  expect(await refused({ column_name: 'X', template: 'work_email' })).toMatch(/inputs/)
  expect(await refused({ column_name: 'X', template: 'crm', inputs: { domain: 'Website' } })).toMatch(/work_email/)
})

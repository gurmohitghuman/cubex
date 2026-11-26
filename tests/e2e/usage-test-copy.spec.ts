import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, BASE, makeAccessToken } from './helpers'
import { freshTreg, seedLeadRows } from './helpers-enrich'
import { call, mcpClient } from './helpers-mcp'
import { openMoreMenu } from './helpers-ui'

// Runs on a test copy count under the sheet it tests (migration 076): an enrichment run on the copy of a test that
// is then discarded (the copy gone) is in the sheet's usage over REST, MCP and the app's Usage view, marked "on
// sample rows", and in the account's usage under the sheet, never as a deleted sheet.

const reuseDays = (api: APIRequestContext, days: number) =>
  api.put('/api/settings/enrich-reuse', { data: { days } }).then(r => expect(r.ok()).toBeTruthy())

test('a test copy\'s runs count in the sheet\'s usage, also once the test is over', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  await reuseDays(api, 0)
  try {
    const { tableId, sheetId } = await seedLeadRows(api, [
      { Name: 'Ada Lovelace', Website: 'acme.example' }, { Name: 'Grace Hopper', Website: 'navy.example' },
      { Name: 'Lin Wu', Website: 'lin.example' },
    ])
    const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e usage test copy')
    const headers = { Authorization: `Bearer ${token}` }
    const start = await api.post(`/api/v1/sheets/${sheetId}/test`, { headers, data: { rows: 2 } })
    expect(start.status(), await start.text()).toBe(201)
    const copyId = (await start.json()).test.test_sheet_id as string
    const run = await api.post(`/api/v1/sheets/${copyId}/enrichment-runs`, { headers, data: {
      tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: 'Work email',
      inputs: { full_name: 'Name', domain: 'Website' },
    } })
    expect(run.status(), await run.text()).toBe(202)
    const runId = (await run.json()).run_id as string
    await expect.poll(async () => (await (await api.get(`/api/v1/http-runs/${runId}`, { headers })).json()).status,
      { timeout: 30_000 }).toBe('completed')
    expect((await api.post(`/api/v1/sheets/${sheetId}/test/discard`, { headers })).ok()).toBeTruthy()
    await expect.poll(async () => (await (await api.get(`/api/v1/sheets/${sheetId}/test`, { headers })).json()).test,
      { timeout: 30_000 }).toBeNull()

    const usage = async (q: Record<string, string>) => {
      const res = await api.get('/api/v1/usage', { headers, params: q })
      expect(res.ok(), await res.text()).toBeTruthy()
      return res.json()
    }
    const sheet = await usage({ sheet_id: sheetId })
    expect(sheet.totals).toMatchObject({ runs: 1, cells: 2 })
    expect(sheet.rows).toEqual([expect.objectContaining({
      sheet_id: sheetId, sheet_deleted: false, column: 'Work email', on_test_copy: true, kind: 'enrichment', runs: 1,
    })])
    const account = (await usage({ group_by: 'run' })).rows as Array<Record<string, unknown>>
    expect(account.find(r => r.run_id === runId)).toMatchObject({ sheet_id: sheetId, on_test_copy: true })
    const client = await mcpClient(token, 'e2e usage test copy')
    const mcp = await call(client, 'get_account', { action: 'usage', sheet_id: sheetId, group_by: 'run' })
    expect(mcp.rows).toEqual([expect.objectContaining({ run_id: runId, sheet_id: sheetId, on_test_copy: true })])
    await client.close()

    // The app's Usage view.
    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await openMoreMenu(page, 'Usage')
    await expect(page.getByTestId('usage-totals')).toContainText('1 run · 2 cells run', { timeout: 15_000 })
    const table = page.getByTestId('usage-table')
    await expect(table).toContainText('Work email')
    await expect(table).toContainText('Enrichment · on sample rows')
    // What ran (the tool) is read from the run's record, which went with the copy, as for any deleted sheet.
    await page.getByTestId('usage-by-run').click()
    await expect(table).toContainText('Work emailcompleted · on sample rows')
  } finally {
    await reuseDays(api, 30)
  }
})

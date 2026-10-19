import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, BASE, makeAccessToken } from './helpers'
import { freshTreg, seedLeadRows } from './helpers-enrich'
import { call, mcpClient } from './helpers-mcp'
import { choose, openMoreMenu } from './helpers-ui'

// The Usage view: what a sheet's runs ran and cost, by column, day or run,
// over a range, with every row as a CSV; a deleted column is still listed with
// what it cost. REST /api/v1/usage and MCP get_usage give the same figures.

const reuseDays = (api: APIRequestContext, days: number) =>
  api.put('/api/settings/enrich-reuse', { data: { days } }).then(r => expect(r.ok()).toBeTruthy())

test('usage by column, day and run; a deleted column stays; the app, REST, MCP and the CSV agree',
  async ({ page, context }) => {
    test.setTimeout(120_000)
    const api = await authedApi()
    await freshTreg(api)
    await reuseDays(api, 0)
    const { tableId, sheetId } = await seedLeadRows(api, [
      { Name: 'Ada Lovelace', Website: 'acme.example' }, { Name: 'Grace Hopper', Website: 'navy.example' },
      { Name: 'Lin Wu', Website: 'lin.example' },
    ])
    const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e usage')
    const headers = { Authorization: `Bearer ${token}` }
    const start = await api.post(`/api/v1/sheets/${sheetId}/enrichment-runs`, { headers, data: {
      tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: 'Work email',
      inputs: { full_name: 'Name', domain: 'Website' },
    } })
    expect(start.status()).toBe(202)
    const runId = (await start.json()).run_id as string
    await expect.poll(async () => (await (await api.get(`/api/v1/http-runs/${runId}`, { headers })).json()).status,
      { timeout: 30_000 }).toBe('completed')
    const cost = (await (await api.get(`/api/v1/http-runs/${runId}`, { headers })).json()).cost_usd as number
    expect(cost).toBeGreaterThan(0)

    const usage = async (q: Record<string, string>) => {
      const res = await api.get('/api/v1/usage', { headers, params: { sheet_id: sheetId, ...q } })
      expect(res.ok(), await res.text()).toBeTruthy()
      return res.json()
    }
    const byColumn = await usage({})
    expect(byColumn.range.range).toBe('this_month')
    expect(byColumn.totals).toMatchObject({ runs: 1, cells: 3, ai_cost_usd: 0 })
    expect(byColumn.totals.enrichment_cost_usd).toBeCloseTo(cost, 6)
    expect(byColumn.totals.total_cost_usd).toBeCloseTo(cost, 6)
    expect(byColumn.totals.cost_per_cell_usd).toBeCloseTo(cost / 3, 6)
    expect(byColumn.rows).toEqual([expect.objectContaining({
      column: 'Work email', column_deleted: false, kind: 'enrichment', runs: 1, cells: 3,
    })])
    const today = new Date().toISOString().slice(0, 10)
    expect((await usage({ group_by: 'day' })).rows.map((r: { day: string }) => r.day)).toEqual([today])
    const byRun = await usage({ group_by: 'run' })
    expect(byRun.rows[0]).toMatchObject({ run_id: runId, what: 'Verified work email', status: 'completed' })
    expect((await usage({ from: '2020-01-01', to: '2020-01-31' })).totals.runs).toBe(0)
    const bad = await api.get('/api/v1/usage', { headers, params: { range: 'yesterday' } })
    expect(bad.status()).toBe(400)
    const csv = await api.get('/api/v1/usage',
      { headers, params: { sheet_id: sheetId, format: 'csv', group_by: 'run' } })
    expect(csv.headers()['content-type']).toContain('text/csv')
    const lines = (await csv.text()).split('\r\n')
    expect(lines[0]).toContain('"Started (UTC)","Sheet","Column"')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(runId)

    // MCP: the same read.
    const client = await mcpClient(token, 'e2e usage')
    const mcp = await call(client, 'get_usage', { sheet_id: sheetId })
    expect(mcp.totals.total_cost_usd).toBeCloseTo(cost, 6)
    expect((await call(client, 'get_usage', {})).totals.runs).toBeGreaterThanOrEqual(1)
    await client.close()

    // A deleted column stays, with what it cost.
    expect((await api.delete(`/api/sheets/${sheetId}/columns/${encodeURIComponent('Work email')}`)).ok()).toBeTruthy()
    const after = await usage({})
    expect(after.rows).toEqual([expect.objectContaining({ column: 'Work email', column_deleted: true, runs: 1 })])
    expect(after.totals.total_cost_usd).toBeCloseTo(cost, 6)

    // The app's Usage view.
    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await openMoreMenu(page, 'Usage')
    const totals = page.getByTestId('usage-totals')
    await expect(totals).toContainText('1 run · 3 cells run', { timeout: 15_000 })
    const table = page.getByTestId('usage-table')
    await expect(table).toContainText('Work email')
    await expect(table).toContainText('Enrichment · deleted')
    await page.getByTestId('usage-by-day').click()
    await expect(table).toContainText(today)
    await page.getByTestId('usage-by-run').click()
    await expect(table).toContainText('Verified work email · completed')
    const download = page.waitForEvent('download')
    await page.getByTestId('usage-csv').click()
    expect((await download).suggestedFilename()).toMatch(/^Sheet1 usage .* by run\.csv$/)
    await choose(page.getByTestId('usage-range'), 'custom')
    await page.getByTestId('usage-from').fill('2020-01-01')
    await page.getByTestId('usage-to').fill('2020-01-31')
    await expect(page.getByTestId('usage-empty')).toHaveText('No runs in this range.')
    await reuseDays(api, 30)
  })

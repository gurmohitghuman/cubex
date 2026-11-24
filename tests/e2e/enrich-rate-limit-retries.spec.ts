// Over 200 lines: one option's two ways in (the drawers, then REST and MCP), each checked from start to recall.
import { test, expect } from '@playwright/test'
import { authedApi, BASE, makeAccessToken } from './helpers'
import { callEveryRow, freshTreg, readDb, seedLeadRows, waitRun } from './helpers-enrich'
import { call, mcpClient } from './helpers-mcp'
import { openColumnType } from './helpers-ui'

// Per-run provider rate-limit retries (rate_limit_retries, 0-10, default 5)
// across the Enrichment drawer, the Waterfall drawer, REST /api/v1 and MCP.
callEveryRow()

const LEADS = [
  { Name: 'Ada Lovelace', Website: 'acme.example' },
  { Name: 'Grace Hopper', Website: 'navy.example' },
]

const configOf = (runId: string) =>
  readDb(db => JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(runId) as string))

test('Enrichment and Waterfall drawers: the retries slider sends and recalls its value', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  // 1. Enrichment drawer: default 5 -> set to 2 -> start -> recall on Edit enrichment.
  await openColumnType(page, 'Enrichment')
  const enrichDrawer = page.getByTestId('enrich-drawer')
  await enrichDrawer.getByTestId('enrich-tool-card').filter({ hasText: 'Verified work email' }).click()
  await expect(enrichDrawer.getByTestId('enrich-run-all')).toHaveText('Run all 2', { timeout: 15_000 })
  await enrichDrawer.getByText('Rows and limits', { exact: true }).click()
  const enrichSlider = enrichDrawer.getByTestId('enrich-rate-limit-retries')
  await expect(enrichSlider).toHaveValue('5')
  await enrichSlider.fill('2')
  await expect(enrichDrawer).toContainText('Retries on rate limits: up to 2 times')
  const enrichRuns = `/enrich/sheets/${sheetId}/runs`
  const enrichStartReq = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith(enrichRuns))
  const enrichStartRes = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(enrichRuns))
  await enrichDrawer.getByTestId('enrich-run-all').click()
  await page.getByRole('dialog').filter({ hasText: 'Run the enrichment' }).getByRole('button', { name: 'Run' }).click()
  expect((await enrichStartReq).postDataJSON().rateLimitRetries).toBe(2)
  const enrichRunId = (await (await enrichStartRes).json()).runId as string
  await expect(enrichDrawer.getByTestId('enrich-run-headline')).toContainText('Ran', { timeout: 30_000 })
  expect(configOf(enrichRunId).enrichment.rateLimitRetries).toBe(2)
  await enrichDrawer.getByTestId('enrich-view-results').click()

  await page.locator('.ag-header-cell').filter({ hasText: 'Verified work email' }).first()
    .locator('.ag-header-cell-text').first().click()
  await page.getByText('Edit enrichment').click()
  await expect(enrichDrawer.getByText('Rows and limits', { exact: true })).toBeVisible({ timeout: 15_000 })
  if (!(await enrichDrawer.getByTestId('enrich-rate-limit-retries').isVisible())) {
    await enrichDrawer.getByText('Rows and limits', { exact: true }).click()
  }
  await expect(enrichDrawer.getByTestId('enrich-rate-limit-retries')).toHaveValue('2')
  await page.keyboard.press('Escape')
  await expect(enrichDrawer).toBeHidden({ timeout: 5_000 })

  // 2. Waterfall drawer: seed a starter waterfall, set slider to 8, run, verify stored & recalled.
  await openColumnType(page, 'Waterfall')
  const wfDrawer = page.getByTestId('waterfall-drawer')
  // The template, not the blank Work email type: templates load after the drawer opens.
  await wfDrawer.getByTestId('waterfall-template-work_email').click()
  const wfSlider = wfDrawer.getByTestId('waterfall-rate-limit-retries')
  await expect(wfSlider).toHaveValue('5')
  await wfSlider.fill('8')
  await expect(wfDrawer).toContainText('Retries on rate limits: up to 8 times')
  await expect(wfDrawer.getByTestId('waterfall-estimate')).toContainText('a row on average', { timeout: 15_000 })
  const wfRuns = `/waterfall/sheets/${sheetId}/runs`
  const wfStartReq = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith(wfRuns))
  const wfStartRes = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(wfRuns))
  await wfDrawer.getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  expect((await wfStartReq).postDataJSON().rateLimitRetries).toBe(8)
  const wfStarted = await (await wfStartRes).json()
  const wfRunId = wfStarted.runId as string
  const wfCol = wfStarted.resultColumn as string
  await expect(wfDrawer.getByTestId('waterfall-run')).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
  expect(configOf(wfRunId).waterfall.rateLimitRetries).toBe(8)
  await wfDrawer.getByRole('button', { name: 'Done' }).click()
  await expect(wfDrawer.getByTestId('waterfall-rate-limit-retries')).toHaveValue('8')
  await page.keyboard.press('Escape')
  await expect(wfDrawer).toBeHidden({ timeout: 5_000 })

  const wfSetup = await (await api.get(
    `/api/waterfall/sheets/${sheetId}/column-setup?column=${encodeURIComponent(wfCol)}`)).json()
  expect(wfSetup.input.rateLimitRetries).toBe(8)
  await api.dispose()
})

test('REST and MCP: rate_limit_retries is checked (0-10), stored and kept on reruns and describe', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e-rate-retries')
  const auth = { Authorization: `Bearer ${token}` }

  // REST enrichment validation & start
  for (const bad of [-1, 11, 2.5]) {
    const res = await api.post(`/api/v1/sheets/${sheetId}/enrichment-runs`, {
      headers: auth,
      data: {
        tool_id: 'treg.people.email.find', column_name: 'Bad Enrich',
        inputs: { full_name: 'Name', domain: 'Website' },
        outputs: [{ field: 'email', column_name: 'Bad Email' }],
        rate_limit_retries: bad,
      },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/rate_limit_retries.*0 to 10/)
  }

  const startEnrich = await api.post(`/api/v1/sheets/${sheetId}/enrichment-runs`, {
    headers: auth,
    data: {
      tool_id: 'treg.people.email.find', column_name: 'REST Enrich',
      inputs: { full_name: 'Name', domain: 'Website' },
      outputs: [{ field: 'email', column_name: 'REST Email' }],
      rate_limit_retries: 0,
    },
  })
  expect(startEnrich.status()).toBe(202)
  const enrichRunId = (await startEnrich.json()).run_id as string
  await waitRun(api, enrichRunId, ['completed'])
  expect(configOf(enrichRunId).enrichment.rateLimitRetries).toBe(0)

  const rerun = await api.post(`/api/v1/http-runs/${enrichRunId}/rerun`, { headers: auth, data: { mode: 'all' } })
  expect(rerun.status()).toBe(202)
  const rerunId = (await rerun.json()).run_id as string
  await waitRun(api, rerunId, ['completed'])
  expect(configOf(rerunId).enrichment.rateLimitRetries).toBe(0)

  // REST waterfall validation, start & GET setup
  const badWf = await api.post(`/api/v1/sheets/${sheetId}/waterfall-columns`, {
    headers: auth,
    data: {
      column_name: 'Bad WF', template: 'work_email',
      inputs: { full_name: 'Name', domain: 'Website' },
      rate_limit_retries: 11,
    },
  })
  expect(badWf.status()).toBe(400)
  expect((await badWf.json()).error).toMatch(/rate_limit_retries.*0 to 10/)

  const startWf = await api.post(`/api/v1/sheets/${sheetId}/waterfall-columns`, {
    headers: auth,
    data: {
      column_name: 'REST WF', template: 'work_email',
      inputs: { full_name: 'Name', domain: 'Website' },
      rate_limit_retries: 7,
    },
  })
  expect(startWf.status()).toBe(202)
  const wfRunId = (await startWf.json()).run_id as string
  await expect.poll(async () => (await (await api.get(`/api/waterfall/runs/${wfRunId}`)).json()).status,
    { timeout: 30_000 }).toBe('completed')
  expect(configOf(wfRunId).waterfall.rateLimitRetries).toBe(7)

  const gotWf = await api.get(
    `/api/v1/sheets/${sheetId}/waterfall-columns/${encodeURIComponent('REST WF')}`, { headers: auth })
  expect(gotWf.status()).toBe(200)
  expect((await gotWf.json()).rate_limit_retries).toBe(7)

  // MCP run_enrichment & waterfall_column
  const client = await mcpClient(token)
  const callRawError = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args }) as {
      isError?: boolean; content?: Array<{ type: string; text?: string }>
    }
    expect(res.isError, JSON.stringify(res)).toBe(true)
    return res.content?.find(c => c.type === 'text')?.text ?? ''
  }
  try {
    expect(await callRawError('run_enrichment', {
      sheet_id: sheetId, tool_id: 'treg.people.email.find', column_name: 'MCP Bad',
      inputs: { full_name: 'Name', domain: 'Website' },
      outputs: [{ field: 'email', column_name: 'MCP Bad Email' }],
      rate_limit_retries: 11,
    })).toMatch(/rate_limit_retries|10/)

    const mcpEnrich = await call(client, 'run_enrichment', {
      sheet_id: sheetId, tool_id: 'treg.people.email.find', column_name: 'MCP Enrich',
      inputs: { full_name: 'Name', domain: 'Website' },
      outputs: [{ field: 'email', column_name: 'MCP Email' }],
      rate_limit_retries: 3,
    })
    await waitRun(api, mcpEnrich.run_id, ['completed'])
    expect(configOf(mcpEnrich.run_id).enrichment.rateLimitRetries).toBe(3)

    expect(await callRawError('waterfall_column', {
      sheet_id: sheetId, column_name: 'MCP Bad WF', template: 'work_email',
      inputs: { full_name: 'Name', domain: 'Website' },
      estimate_only: false, rate_limit_retries: -1,
    })).toMatch(/rate_limit_retries|0/)

    const mcpWf = await call(client, 'waterfall_column', {
      sheet_id: sheetId, column_name: 'MCP WF', template: 'work_email',
      inputs: { full_name: 'Name', domain: 'Website' },
      estimate_only: false, rate_limit_retries: 9,
    })
    await expect.poll(async () => (await (await api.get(`/api/waterfall/runs/${mcpWf.run_id}`)).json()).status,
      { timeout: 30_000 }).toBe('completed')
    expect(configOf(mcpWf.run_id).waterfall.rateLimitRetries).toBe(9)

    const described = await call(client, 'waterfall_column', {
      action: 'describe', sheet_id: sheetId, column_name: 'MCP WF',
    })
    expect(described.rate_limit_retries).toBe(9)
  } finally {
    await client.close()
  }
  await api.dispose()
})

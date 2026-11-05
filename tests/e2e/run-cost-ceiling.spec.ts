// Over 200 lines: one ceiling story per surface (MCP, REST, the app), each on its own seeded sheet.
import { test, expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, BASE, makeAccessToken, getSheet } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// A cost ceiling and an AI run's spend limit over MCP, /api/v1 and the app
// (docs/mcp.md, "Cost ceiling and spend limits"). OpenRouter's public price
// list prices the model; the key is fake, so a row that runs fails for free
// and spends nothing.
//   - max_cost_usd under the estimate's high end plus one row's most (the
//     room the run's spend limit keeps for its next row): run_ai_column and
//     apply_setup refuse it (MCP error, REST 409 over_ceiling with the
//     estimate) and create nothing; estimate_only says over_ceiling,
//     ceiling_problem (both figures) and row_most_usd instead;
//   - spend_limit_usd sets a limit without that check: one below a row's most
//     pauses the run before any call (pause_reason spend_limit) with its rows
//     still ⏳; a resume that leaves no room is refused; in the app, Resume asks
//     for a higher limit (from a light read, never the run's results: the
//     column, why it paused, the least the server takes, to the micro-dollar,
//     filled in with that least plus the rows left at what a row cost so far,
//     the worst case to finish only as words) and goes on with it; Resume all
//     with two runs at their limit asks for each, one after the other; a rerun
//     takes a limit too and resumes over REST;
//   - the AI drawer's own Resume asks in the same dialog, and its poll follows
//     the resumed run to the end;
//   - a setup applied under a ceiling gives its AI step that as its limit.

const FAKE_KEY = 'sk-or-v1-cost-ceiling-e2e'
const MODEL = 'openai/gpt-4o-mini'
const TINY = 0.000001
const WAITING = '⏳ Processing...'

async function aiStatus(client: Client, runId: string, statuses: string[]) {
  let last: any
  await expect.poll(async () => (last = await call(client, 'get_run_status',
    { run_type: 'ai', run_id: runId, wait_seconds: 2 })).status, { timeout: 60_000 }).toMatch(
    new RegExp(`^(${statuses.join('|')})$`))
  return last
}
// A limit to the micro-dollar, as the dialog shows it (client lib/enrich-format.ts limitText).
const exact = (usd: number) => `$${usd.toFixed(6).replace(/0+$/, '')}`
const cells = async (api: APIRequestContext, sheetId: string, column: string) =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data[column] ?? '')

async function priced(client: Client, sheetId: string): Promise<boolean> {
  const est = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Probe', prompt: 'Say hi to /val', model: MODEL, estimate_only: true,
  })
  return est.pricing_available === true
}

test('an AI run: refused over its ceiling, paused at its spend limit, resumed with a higher one', async ({
  page, context,
}) => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e cost ceiling')
  const client = await mcpClient(token)
  const auth = { Authorization: `Bearer ${token}` }
  test.skip(!(await priced(client, sheetId)), "OpenRouter's public price list is unreachable")
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: FAKE_KEY } })).ok()).toBeTruthy()
  try {
    const base = { sheet_id: sheetId, column_name: 'Hi', prompt: 'Say hi to /val', model: MODEL }

    // The agent is told, in the tools it starts and controls runs with.
    const tools = (await client.listTools()).tools
    const text = (name: string) => tools.find(x => x.name === name)?.description ?? ''
    expect(text('run_ai_column')).toContain('COST CEILING: max_cost_usd refuses to start')
    expect(text('run_ai_column')).toContain('pause_reason spend_limit')
    expect(text('apply_setup')).toContain('COST CEILING: max_cost_usd refuses to start')

    // estimate_only says it is over, and starts nothing.
    const est = await call(client, 'run_ai_column', { ...base, estimate_only: true, max_cost_usd: TINY })
    expect(est).toMatchObject({ max_cost_usd: TINY, over_ceiling: true })
    expect(est.ceiling_problem).toMatch(/^It could cost up to \$[\d.]+, and its spend limit starts a row only /)
    expect(est.ceiling_problem).toContain('more than the $0.000001 ceiling (max_cost_usd)')
    expect(est.row_most_usd).toBeGreaterThan(est.estimated_cost_usd.high)
    const roomy = await call(client, 'run_ai_column', { ...base, estimate_only: true, max_cost_usd: 1000 })
    expect(roomy).toMatchObject({ max_cost_usd: 1000, over_ceiling: false, ceiling_problem: null })
    expect((await call(client, 'run_ai_column', { ...base, estimate_only: true })).over_ceiling).toBeUndefined()

    // A start over it is refused with the estimate; nothing is made.
    const refused = await callError(client, 'run_ai_column', { ...base, max_cost_usd: TINY })
    expect(refused).toContain('more than the $0.000001 ceiling (max_cost_usd)')
    expect(refused).toContain('Estimate: {')
    const rest = await api.post(`${BASE}/api/v1/sheets/${sheetId}/ai-runs`,
      { headers: auth, data: { ...base, sheet_id: undefined, max_cost_usd: TINY } })
    expect(rest.status()).toBe(409)
    const body = await rest.json()
    expect(body).toMatchObject({ over_ceiling: true, estimate: { over_ceiling: true, rows_to_process: 3 } })
    expect(body.error).toContain('ceiling (max_cost_usd)')
    const restEst = await api.post(`${BASE}/api/v1/sheets/${sheetId}/ai-runs`,
      { headers: auth, data: { ...base, sheet_id: undefined, max_cost_usd: TINY, estimate_only: true } })
    expect(restEst.status()).toBe(200)
    expect(await restEst.json()).toMatchObject({ over_ceiling: true, max_cost_usd: TINY })
    expect((await api.post(`${BASE}/api/v1/sheets/${sheetId}/ai-runs`,
      { headers: auth, data: { ...base, sheet_id: undefined, max_cost_usd: 0 } })).status()).toBe(400)

    // Above the high end but short of one row's most on top: a run limited to it would stop before its rows.
    const high = est.estimated_cost_usd.high, most = est.row_most_usd
    const short = Math.round((high + most / 2) * 1e6) / 1e6
    const shortEst = await call(client, 'run_ai_column', { ...base, estimate_only: true, max_cost_usd: short })
    expect(shortEst.over_ceiling).toBe(true)
    expect(shortEst.ceiling_problem).toContain('needs room for one row at its most on top (up to $')
    expect(shortEst.ceiling_problem).toMatch(/Raise max_cost_usd to at least \$[\d.]+, or run fewer rows\.$/)
    expect(await callError(client, 'run_ai_column', { ...base, max_cost_usd: short }))
      .toContain('needs room for one row at its most on top')
    const need = Math.ceil((high + most) * 1e6) / 1e6
    expect((await call(client, 'run_ai_column', { ...base, estimate_only: true, max_cost_usd: need })).over_ceiling)
      .toBe(false)
    expect((await call(client, 'get_sheet', { sheet_id: sheetId })).columns).not.toContain('Hi (Output)')
    expect((await call(client, 'list_runs', { sheet_id: sheetId })).runs).toEqual([])

    // spend_limit_usd below one row's most (no ceiling check): the run pauses before any call, its rows waiting.
    const started = await call(client, 'run_ai_column', { ...base, spend_limit_usd: TINY })
    expect(started.spend_limit_usd).toBe(TINY)
    const paused = await aiStatus(client, started.run_id, ['paused'])
    expect(paused).toMatchObject({ pause_reason: 'spend_limit', spend_limit_usd: TINY, processed_rows: 0 })
    expect(paused.pause_message).toMatch(/^The run reached its \$0\.000001 spend limit \(\$0\.00 spent\)\. The next/)
    expect(paused.pause_message).toContain('Resume it with a higher limit to go on.')
    expect(await cells(api, sheetId, 'Hi (Output)')).toEqual([WAITING, WAITING, WAITING])
    const restRun = await (await api.get(`${BASE}/api/v1/ai-runs/${started.run_id}`, { headers: auth })).json()
    expect(restRun).toMatchObject({ status: 'paused', pause_reason: 'spend_limit', spend_limit_usd: TINY })

    // Resuming without room is refused and changes nothing; a bad limit too.
    const noRoom = await api.post(`${BASE}/api/v1/ai-runs/${started.run_id}/resume`, { headers: auth, data: {} })
    expect(noRoom.status()).toBe(400)
    expect((await noRoom.json()).error).toContain('Resume it with a higher spend_limit_usd')
    const bad = await api.post(`${BASE}/api/v1/ai-runs/${started.run_id}/resume`,
      { headers: auth, data: { spend_limit_usd: 'ten' } })
    expect(bad.status()).toBe(400)
    expect(await callError(client, 'control_run', { run_type: 'ai', run_id: started.run_id, action: 'resume' }))
      .toContain('higher spend_limit_usd')
    expect((await aiStatus(client, started.run_id, ['paused'])).spend_limit_usd).toBe(TINY)

    // In the app, Resume asks for a higher limit, then goes on: every row runs (and fails on the fake key, free).
    // The dialog reads the light spend-limit route, never the run with all its results.
    const view = await (await api.get(`/api/ai/runs/${started.run_id}/spend-limit`)).json()
    expect(view).toMatchObject({ column_name: 'Hi (Output)', pause_reason: 'spend_limit', limit_usd: TINY,
      spent_usd: 0, cut_off_usd: 0, rows_left: 3, message: paused.pause_message })
    // Nothing spent, nothing cut off: the least is the next row's most. No row has run, so the amount filled
    // in is that least, rounded up (two figures); the worst case (every row left at its most) is only words.
    expect(Math.round(view.least_usd * 1e6)).toBe(Math.round(view.next_row_usd * 1e6))
    expect(view.avg_row_usd).toBeNull()
    expect(Math.round(view.suggest_usd * 1e6)).toBeGreaterThanOrEqual(Math.round(view.least_usd * 1e6))
    expect(view.suggest_usd).toBeLessThan(view.least_usd * 1.1)
    expect(view.finish_usd).toBeGreaterThanOrEqual(3 * view.next_row_usd - 1e-9)
    expect(view.finish_usd).toBeGreaterThan(view.suggest_usd)
    const fullRead = `/api/ai/runs/${started.run_id}`
    const fullReads: string[] = []
    page.on('request', r => { if (new URL(r.url()).pathname === fullRead) fullReads.push(r.url()) })
    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    const lightRead = page.waitForRequest(r => new URL(r.url()).pathname === `${fullRead}/spend-limit`)
    await page.getByTitle('Resume all runs').click()
    await lightRead
    const dialog = page.getByTestId('ai-raise-limit')
    await expect(dialog).toContainText('Hi (Output)')
    await expect(dialog.getByTestId('ai-raise-limit-why')).toHaveText(paused.pause_message)
    await expect(dialog.getByTestId('ai-raise-limit-least')).toContainText(
      `It needs at least ${exact(view.least_usd)} to go on: what it spent ($0.00), plus its next row at its most`)
    const limit = dialog.getByLabel('New limit')
    await expect(limit).toHaveValue(String(view.suggest_usd))
    await expect(dialog.getByTestId('ai-raise-limit-filled')).toHaveText(
      'The amount filled in is that least: no row has run yet to show what one costs.')
    await expect(dialog.getByTestId('ai-raise-limit-finish')).toHaveText(
      /^To finish for sure, even if every row left costs its most, it would need \$0\.\d+\.$/)
    // A micro-dollar under the least is refused here, as the server refuses it; the least itself is taken.
    const raise = dialog.getByRole('button', { name: 'Raise and resume' })
    await limit.fill(((Math.round(view.least_usd * 1e6) - 1) / 1e6).toFixed(6))
    await expect(dialog).toContainText(`Enter at least ${exact(view.least_usd)}.`)
    await expect(raise).toBeDisabled()
    await limit.fill(view.least_usd.toFixed(6))
    await expect(raise).toBeEnabled()
    // Empty isn't a choice here, so the hint doesn't offer it.
    await limit.fill('ten')
    await expect(dialog).toContainText('Enter an amount above $0.')
    await expect(dialog).not.toContainText('or leave it empty')
    await expect(raise).toBeDisabled()
    await limit.fill('5')
    await raise.click()
    await expect(dialog).toBeHidden()
    expect(fullReads).toEqual([])
    const done = await aiStatus(client, started.run_id, ['completed', 'failed'])
    expect(done.spend_limit_usd).toBe(5)
    expect(done.pause_reason).toBeUndefined()
    expect(await cells(api, sheetId, 'Hi (Output)')).not.toContain(WAITING)

    // A rerun takes a limit of its own (REST), and pauses at it the same way.
    const rerun = await api.post(`${BASE}/api/v1/ai-runs/${started.run_id}/rerun`,
      { headers: auth, data: { mode: 'all', spend_limit_usd: TINY } })
    expect(rerun.status()).toBe(202)
    const again = await rerun.json()
    const rerunPaused = await aiStatus(client, again.run_id, ['paused'])
    expect(rerunPaused).toMatchObject({ pause_reason: 'spend_limit', spend_limit_usd: TINY })
    const resumed = await api.post(`${BASE}/api/v1/ai-runs/${again.run_id}/resume`,
      { headers: auth, data: { spend_limit_usd: 5 } })
    expect(resumed.ok(), await resumed.text()).toBeTruthy()
    expect((await aiStatus(client, again.run_id, ['completed', 'failed'])).spend_limit_usd).toBe(5)

    // Resume all with two runs at their limit: each asks for its own, one after the other.
    const two = [await call(client, 'run_ai_column', { ...base, column_name: 'Two', spend_limit_usd: TINY }),
      await call(client, 'run_ai_column', { ...base, column_name: 'Three', spend_limit_usd: TINY })]
    for (const r of two) await aiStatus(client, r.run_id, ['paused'])
    await page.reload()
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await page.getByTitle('Resume all runs').click()
    const column = dialog.locator('p.font-medium')
    await expect(dialog).toContainText('Then 1 more run that stopped at its spend limit, one at a time.')
    const first = await column.innerText()
    await dialog.getByLabel('New limit').fill('5')
    await raise.click()
    await expect(column).not.toHaveText(first)
    await expect(dialog.getByTestId('ai-raise-limit-least')).toBeVisible()
    expect([first, await column.innerText()].sort()).toEqual(['Three (Output)', 'Two (Output)'])
    await expect(dialog).not.toContainText('more run')
    await dialog.getByLabel('New limit').fill('5')
    await raise.click()
    await expect(dialog).toBeHidden()
    for (const r of two) expect((await aiStatus(client, r.run_id, ['completed', 'failed'])).spend_limit_usd).toBe(5)
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
})

test("the AI drawer's Resume on a run at its spend limit asks for a higher one; its poll follows the run", async ({
  page, context,
}) => {
  test.setTimeout(150_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e drawer limit')
  const client = await mcpClient(token)
  test.skip(!(await priced(client, sheetId)), "OpenRouter's public price list is unreachable")
  expect((await api.put(`/api/sheets/${sheetId}/default-model`, { data: { model: MODEL } })).ok()).toBeTruthy()
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: FAKE_KEY } })).ok()).toBeTruthy()
  try {
    await context.addCookies((await api.storageState()).cookies)
    // The drawer starts runs without a limit: this one gets a tiny one on its way to the server.
    await page.route('**/api/ai/run', async route => {
      const body = JSON.parse(route.request().postData() ?? '{}')
      await route.continue({ postData: JSON.stringify({ ...body, spendLimitUsd: TINY }) })
    })
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
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
      return run ? `${run.status}/${run.pause_reason}/${run.spend_limit_usd}` : ''
    }, { timeout: 60_000 }).toBe(`paused/spend_limit/${TINY}`)

    // The drawer closed when the run started; opened again it shows the run where it stopped.
    if (!(await page.getByTestId('run-self-paused').isVisible())) {
      await page.getByRole('button', { name: 'AI Column', exact: true }).click()
    }
    const why = page.getByTestId('run-self-paused')
    await expect(why).toContainText('spend limit', { timeout: 30_000 })
    const fullReads: string[] = []
    page.on('request', r => { if (new URL(r.url()).pathname === `/api/ai/runs/${runId}`) fullReads.push(r.url()) })
    await page.getByRole('dialog').filter({ has: why }).getByRole('button', { name: 'Resume', exact: true }).click()
    const dialog = page.getByTestId('ai-raise-limit')
    await expect(dialog).toContainText('Drawer (Output)')
    await expect(dialog.getByTestId('ai-raise-limit-least')).toContainText('It needs at least $')
    await dialog.getByLabel('New limit').fill('5')
    await dialog.getByRole('button', { name: 'Raise and resume' }).click()
    await expect(dialog).toBeHidden()
    // The drawer's poll (a full read, the drawer's own) picks the resumed run up and follows it to the end:
    // rows fail for free on the fake key, and the drawer goes back to a fresh start.
    const done = await aiStatus(client, runId, ['completed', 'failed'])
    expect(done.spend_limit_usd).toBe(5)
    await expect(why).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('#prompt')).toHaveValue('', { timeout: 30_000 })
    expect(fullReads.length).toBeGreaterThan(0)
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
})

test('apply_setup: refused over its ceiling over MCP and REST; its AI step gets the ceiling as its limit', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e setup ceiling')
  const client = await mcpClient(token)
  const auth = { Authorization: `Bearer ${token}` }
  test.skip(!(await priced(client, sheetId)), "OpenRouter's public price list is unreachable")
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  const file = {
    format: 'cubex-setup', version: 1, name: 'Ceiling greet', description: null,
    spec: { v: 1, inputs: ['val'], keys: [], steps: [
      { kind: 'formula', name: 'Shout', formula: '{{val}}.toUpperCase()', description: null, autoRun: false },
      { kind: 'ai', name: 'Greet', prompt: 'Say hi to /shout', systemPrompt: null, model: MODEL, temperature: 0.7,
        maxChars: null, concurrency: null, webSearch: false, webFetch: false, search: null, outputColumns: null,
        runIf: null },
    ] },
  }
  const imported = await api.post(`${BASE}/api/v1/setups/import`, { headers: auth, data: file })
  expect(imported.status(), await imported.text()).toBe(201)
  const setupId = (await imported.json()).id
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: FAKE_KEY } })).ok()).toBeTruthy()
  try {
    // MCP: the estimate (its default) says over; a start is refused and makes nothing.
    const est = await call(client, 'apply_setup', { sheet_id: sheetId, setup_id: setupId, max_cost_usd: TINY })
    expect(est.estimate).toMatchObject({ max_cost_usd: TINY, over_ceiling: true })
    expect(est.estimate.ceiling_problem).toContain('more than the $0.000001 ceiling (max_cost_usd)')
    const refused = await callError(client, 'apply_setup',
      { sheet_id: sheetId, setup_id: setupId, max_cost_usd: TINY, estimate_only: false })
    expect(refused).toContain('more than the $0.000001 ceiling (max_cost_usd)')
    expect(refused).toContain('Estimate: {')

    // REST: 409 with the estimate; the estimate itself is a 200.
    const url = `${BASE}/api/v1/sheets/${sheetId}/setups/${setupId}/apply`
    const rest = await api.post(url, { headers: auth, data: { max_cost_usd: TINY } })
    expect(rest.status()).toBe(409)
    const body = await rest.json()
    expect(body).toMatchObject({ over_ceiling: true, estimate: { over_ceiling: true } })
    expect(body.estimate.steps.map((s: any) => s.column)).toEqual(['Shout', 'Greet (Output)'])
    const restEst = await api.post(url, { headers: auth, data: { max_cost_usd: TINY, estimate_only: true } })
    expect(restEst.status()).toBe(200)
    expect((await restEst.json()).estimate).toMatchObject({ over_ceiling: true })
    expect((await api.post(url, { headers: auth, data: { max_cost_usd: -1 } })).status()).toBe(400)
    expect((await call(client, 'get_setup_run', { sheet_id: sheetId })).setup_runs).toEqual([])
    const columns = (await call(client, 'get_sheet', { sheet_id: sheetId })).columns
    expect(columns).not.toContain('Shout')
    expect(columns).not.toContain('Greet (Output)')

    // Under a roomy ceiling it starts; its AI step's run carries the ceiling as its hard limit.
    const ok = await api.post(url, { headers: auth, data: { max_cost_usd: 5 } })
    expect(ok.status(), await ok.text()).toBe(201)
    const run = (await ok.json()).setup_run
    expect(run.max_cost_usd).toBe(5)
    let greet: any
    await expect.poll(async () => {
      const r = await call(client, 'get_setup_run', { setup_run_id: run.id })
      greet = r.steps.find((s: any) => s.column === 'Greet (Output)')
      return greet?.run_id ?? null
    }, { timeout: 60_000 }).not.toBeNull()
    const status = await aiStatus(client, greet.run_id, ['running', 'paused', 'completed', 'failed'])
    expect(status.spend_limit_usd).toBe(5)
    await expect.poll(async () => (await call(client, 'get_setup_run', { setup_run_id: run.id })).status,
      { timeout: 60_000 }).toMatch(/done|failed/)
  } finally {
    await api.delete('/api/settings/openrouter-key')
    for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  }
})

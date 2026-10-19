import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, BASE, makeAccessToken } from './helpers'
import { callEveryRow, expectBilledOnce, freshTreg, rowsOf, runIdsOf, seedLeadRows } from './helpers-enrich'
import { call, callError, mcpClient, waitMcpRun } from './helpers-mcp'

// A spend cap per access token: set and shown in Settings (cookie only), told
// to the agent (GET /v1/me, get_balances, the run tools' text, a start's
// answer), and at the cap an enrichment run pauses with token_cap, a new start
// and a resume are refused, until the cap is raised in Settings.

callEveryRow()
const LEADS = Array.from({ length: 6 }, (_, i) => ({ Name: `Cap Person${i}`, Website: `cap${i}.example` }))
const FIND = {
  tool_id: 'treg.people.email.find', column_name: 'Find email', inputs: { full_name: 'Name', domain: 'Website' },
  outputs: [{ field: 'email', column_name: 'Email' }], max_cost_per_row_usd: 0.01,
}

test('a token at its spend cap: refused and paused, then resumed after a raise in Settings', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS)
  const raw = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e spend cap')
  const listed = async () => ((await (await api.get('/api/settings/access-tokens')).json()) as Array<any>)
    .find(t => t.name === 'e2e spend cap')
  const tok = await listed()
  expect(tok.spend).toEqual({ spend_cap_usd: null, spent_usd: 0, left_usd: null })

  // Settings sets it; a bad amount or an unknown token says so; a token can't reach the route at all.
  const set = (id: string, cap: unknown) =>
    api.patch(`/api/settings/access-tokens/${id}`, { data: { spend_cap_usd: cap } })
  expect((await set(tok.id, 'ten')).status()).toBe(400)
  expect((await set('no-such-token', 1)).status()).toBe(404)
  const capped = await set(tok.id, 0.02)
  expect(capped.ok()).toBeTruthy()
  expect((await capped.json()).spend).toEqual({ spend_cap_usd: 0.02, spent_usd: 0, left_usd: 0.02 })
  const bearer = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${raw}` } })
  expect((await bearer.patch(`/api/settings/access-tokens/${tok.id}`, { data: { spend_cap_usd: 100 } })).status())
    .toBe(401)
  const me = await (await bearer.get('/api/v1/me')).json()
  expect(me.token.spend).toMatchObject({ spend_cap_usd: 0.02, spent_usd: 0, left_usd: 0.02 })
  expect(me.token.spend.note).toContain('whole life, not a month')

  // The agent is told: the tools that spend say the cap, what is left and how far past it spend can go.
  const client = await mcpClient(raw)
  const tools = (await client.listTools()).tools
  const text = (name: string) => tools.find(x => x.name === name)?.description ?? ''
  for (const name of ['run_ai_column', 'run_enrichment', 'waterfall_column', 'control_run', 'apply_setup']) {
    expect(text(name), name).toContain('SPEND CAP: this access token may spend $0.02 in all')
    expect(text(name), name).toContain('not per month')
    expect(text(name), name).toContain('Calls already in flight finish and count')
  }
  expect(text('write_formula')).toContain('At the cap this is refused.')
  expect(text('read_rows')).not.toContain('SPEND CAP')
  expect((await call(client, 'get_balances', {})).access_token).toMatchObject({ spend_cap_usd: 0.02, left_usd: 0.02 })

  // Two rows fit at up to $0.01 each: the run pauses at the cap with the rest still to do.
  const started = await call(client, 'run_enrichment', { sheet_id: sheetId, ...FIND })
  expect(started.token_spend).toMatchObject({ spend_cap_usd: 0.02 })
  const paused = await waitMcpRun(client, started.run_id, ['paused'])
  expect(paused.enrichment.pause_reason).toBe('token_cap')
  expect(paused.error_message).toContain('"e2e spend cap"')
  const spent = (await call(client, 'get_balances', {})).access_token
  expect(spent.spent_usd).toBeGreaterThan(0)
  expect(spent.spent_usd).toBeLessThanOrEqual(0.02)
  expect((await rowsOf(api, sheetId)).filter(r => r['Find email'] === '✅ Found').length).toBeLessThan(6)

  // At the cap (set to exactly what it spent): a run, a preview and a resume are refused.
  await set(tok.id, spent.spent_usd)
  expect(await callError(client, 'run_enrichment', { sheet_id: sheetId, ...FIND, column_name: 'Again' }))
    .toContain('spend cap')
  expect(await callError(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Hi', prompt: 'Say hi to /name', model: 'openai/gpt-4o-mini', preview_rows: 1,
  })).toContain('spend cap')
  expect(await callError(client, 'control_run', { run_type: 'enrichment', run_id: started.run_id, action: 'resume' }))
    .toContain('whole life, not a month')

  // Settings shows it and raises it; then the run resumes and finishes.
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/settings/agents`)
  const row = page.getByTestId('token-spend').filter({ hasText: 'of its' })
  await expect(row).toContainText('left')
  await expect(row).toContainText('At the cap')
  await row.getByRole('button', { name: 'Change cap' }).click()
  await page.getByLabel('Spend cap for e2e spend cap').fill('1')
  await page.getByTestId('token-cap-editor').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('"e2e spend cap" may spend $1.00 in all')).toBeVisible()
  expect((await listed()).spend.spend_cap_usd).toBe(1)
  await call(client, 'control_run', { run_type: 'enrichment', run_id: started.run_id, action: 'resume' })
  await waitMcpRun(client, started.run_id, ['completed'])
  expect((await rowsOf(api, sheetId)).filter(r => r['Find email'] === '✅ Found')).toHaveLength(6)
  const after = (await call(client, 'get_balances', {})).access_token
  expect(after.spent_usd).toBeGreaterThan(spent.spent_usd)
  // The usage history counts the same numbers.
  const usage = await (await bearer.get(`/api/v1/usage?sheet_id=${sheetId}`)).json()
  expect(usage.totals.total_cost_usd).toBeCloseTo(after.spent_usd, 6)
  await expectBilledOnce(runIdsOf(sheetId))
  await bearer.dispose()
  await api.dispose()
})

test('the create dialog takes a cap; the token list shows what each token spent', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  for (const t of await (await api.get('/api/settings/access-tokens')).json()) {
    if (t.name === 'Capped from the dialog') await api.delete(`/api/settings/access-tokens/${t.id}`)
  }
  await page.goto(`${BASE}/settings/agents`)
  await page.getByRole('button', { name: 'Create token' }).first().click()
  await page.getByPlaceholder('e.g., Claude MCP, enrichment-script').fill('Capped from the dialog')
  await expect(page.getByText("The cap is for the token's whole life, not a month")).toBeVisible()
  await page.getByLabel('Spend cap ($)').fill('7.5')
  await page.getByRole('button', { name: 'Create token', exact: true }).last().click()
  await expect(page.getByRole('heading', { name: 'Access token created' })).toBeVisible()
  await page.getByRole('button', { name: 'Done' }).click()
  const made = ((await (await api.get('/api/settings/access-tokens')).json()) as Array<any>)
    .find(t => t.name === 'Capped from the dialog')
  expect(made.spend).toEqual({ spend_cap_usd: 7.5, spent_usd: 0, left_usd: 7.5 })
  await expect(page.getByTestId('token-spend').filter({ hasText: '$7.50 cap' })).toContainText('$0.00 spent')
  // Emptied, the cap is gone.
  await page.getByTestId('token-spend').filter({ hasText: '$7.50 cap' }).getByRole('button', { name: 'Change cap' })
    .click()
  await page.getByLabel('Spend cap for Capped from the dialog').fill('')
  await page.getByTestId('token-cap-editor').getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('"Capped from the dialog" has no spend cap now')).toBeVisible()
  await api.delete(`/api/settings/access-tokens/${made.id}`)
  await api.dispose()
})

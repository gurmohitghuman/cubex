import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, makeAccessToken } from './helpers'
import { MOCK_TEAM_KEY, mockTreg, setTregKey } from './helpers-treg'
import { freshTreg, runStatus, seedLeadRows, startRun, waitRun } from './helpers-enrich'
import { mcpClient, call } from './helpers-mcp'
import { expectLine, listed, openSheet, pausedLine, putPause } from './helpers-paused'

// Enrichment runs that paused themselves, on the sheet (components/sheet/PausedRunsNotice.tsx): the line under
// the header names the column and says why and what to change, in the words the run saved. Its Resume carries
// the run on; at its own run limit or today's limit it offers Open instead, the run's drawer, where the raise is
// (a plain resume would only stop again). The mock treg refuses as treg does (a bad key, the balance, its daily
// cap, a team rule, a provider out); unreachable and unconfirmed (five failed tries 10 s apart, 15 minutes with
// no answer) and dest_full (a list's sheet at the row cap, which the suite's servers don't lower) are put in
// place in the test database as the runner writes them.
const LEADS = Array.from({ length: 8 }, (_, i) => ({ Name: `Paused Person${i}`, Website: `paused${i}.example` }))
const COLUMN = 'Find email'
let api: APIRequestContext

const findRun = (over: Record<string, unknown> = {}) => ({
  toolId: 'treg.people.email.find', preset: null, columnName: COLUMN, continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
  rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
  ...over,
})

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { api = await authedApi() })
test.afterAll(async () => { await setTregKey(api, MOCK_TEAM_KEY) })

async function pausedOn(state: Record<string, unknown>, reason: string, over: Record<string, unknown> = {}) {
  await freshTreg(api, state)
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  const runId = await startRun(api, sheetId, findRun(over))
  expect((await waitRun(api, runId, ['paused'], 30_000)).pauseReason).toBe(reason)
  return { tableId, sheetId, runId }
}
const resumeLine = (page: Page, runId: string) =>
  pausedLine(page, runId).getByRole('button', { name: `Resume ${COLUMN}` }).click()
async function finishes(page: Page, runId: string) {
  await waitRun(api, runId, ['completed'], 60_000)
  await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
}

for (const c of [
  { reason: 'auth', state: { scenario: { kind: '401', count: 1 } },
    words: 'treg rejected the key (invalid token). Check it in Settings, then Resume.' },
  { reason: 'treg_cap', state: { scenario: { kind: 'daily_cap', count: 1 } },
    words: "Your treg team's daily cap is reached (set at treg, Team settings). It isn't Cubex's daily limit." },
  { reason: 'team_rule', state: { scenario: { kind: 'pinned', count: 1 } },
    words: 'Your treg team only allows hunter for this job. Change it at treg or pick that provider.' },
  { reason: 'provider_busy', state: { scenario: { kind: 'capacity', count: 1 } },
    words: "treg's own account for apollo is out right now. Resume later, or connect your own key at treg." },
  { reason: 'balance', state: { balanceMicro: 6000 }, fixed: { balanceMicro: 1_000_000 },
    words: /Your treg balance ran out \(\$[\d.]+ left\)\. Top up at treg, then Resume\./ },
]) {
  test(`${c.reason}: the line says what treg refused; once fixed, its Resume finishes the run`, async ({
    page, context,
  }) => {
    test.setTimeout(90_000)
    const { tableId, runId } = await pausedOn(c.state, c.reason)
    await openSheet(page, context, api, tableId)
    await expectLine(page, runId, COLUMN, c.words)
    if (c.fixed) await mockTreg.set(c.fixed)
    await resumeLine(page, runId)
    await finishes(page, runId)
  })
}

test('no_key: the key removed mid-run; the line says to add one, and Resume finishes once it is back', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  await freshTreg(api, { delayMs: 1500 })
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  const runId = await startRun(api, sheetId, findRun())
  await expect.poll(async () => (await mockTreg.requests()).filter(r => r.path.startsWith('/call/')).length,
    { timeout: 15_000 }).toBeGreaterThan(0)
  await setTregKey(api, null)
  expect((await waitRun(api, runId, ['paused'], 20_000)).pauseReason).toBe('no_key')
  await openSheet(page, context, api, tableId)
  await expectLine(page, runId, COLUMN, 'No treg key. Add one in Settings, then Resume.')
  await setTregKey(api, MOCK_TEAM_KEY)
  await resumeLine(page, runId)
  await finishes(page, runId)
})

test("spend_limit and daily_limit: the line offers Open, the drawer's raise, and the run finishes", async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  const run = await pausedOn({}, 'spend_limit', { maxCostPerRowUsd: 0.01, spendLimitUsd: 0.02 })
  await openSheet(page, context, api, run.tableId)
  const line = await expectLine(page, run.runId, COLUMN, /reached its \$0\.02 spend limit/)
  await expect(line.getByRole('button', { name: /Resume/ })).toHaveCount(0)
  await line.getByRole('button', { name: 'Open' }).click()
  await page.getByTestId('enrich-paused').getByLabel('Raise the run limit to').fill('1')
  await page.getByTestId('enrich-raise-resume').click()
  await finishes(page, run.runId)
  try {
    expect((await api.put('/api/settings/enrich-daily-limit', { data: { limitUsd: 0.01 } })).ok()).toBeTruthy()
    const daily = await pausedOn({}, 'daily_limit', { maxCostPerRowUsd: 0.02 })
    await openSheet(page, context, api, daily.tableId)
    const dl = await expectLine(page, daily.runId, COLUMN, "Today's $0.01 enrichment limit is reached.")
    await dl.getByRole('button', { name: 'Open' }).click()
    await page.getByTestId('enrich-paused').getByLabel('Raise the daily limit to').fill('5')
    await page.getByTestId('enrich-raise-resume').click()
    await finishes(page, daily.runId)
  } finally {
    await api.put('/api/settings/enrich-daily-limit', { data: { limitUsd: 10 } })
  }
})

test("token_cap: an agent's run at its token's cap; raised, the line's Resume finishes it", async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  await freshTreg(api)
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  const name = 'sheet paused enrichment cap'
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], name))
  const tok = ((await (await api.get('/api/settings/access-tokens')).json()) as Array<any>).find(t => t.name === name)
  const cap = (usd: number) => api.patch(`/api/settings/access-tokens/${tok.id}`, { data: { spend_cap_usd: usd } })
  expect((await cap(0.02)).ok()).toBeTruthy()
  const started = await call(client, 'run_enrichment', { sheet_id: sheetId, tool_id: 'treg.people.email.find',
    column_name: COLUMN, inputs: { full_name: 'Name', domain: 'Website' },
    outputs: [{ field: 'email', column_name: 'Email' }], max_cost_per_row_usd: 0.01 })
  expect((await waitRun(api, started.run_id, ['paused'])).pauseReason).toBe('token_cap')
  await openSheet(page, context, api, tableId)
  await expectLine(page, started.run_id, COLUMN, `"${name}"`)
  expect((await cap(1)).ok()).toBeTruthy()
  await resumeLine(page, started.run_id)
  await finishes(page, started.run_id)
})

for (const c of [
  { reason: 'unreachable', words: "Can't reach treg. Check the server's internet connection, then Resume." },
  { reason: 'unconfirmed', words: "treg hasn't confirmed a call for 15 minutes. Resume later to ask again; a call it "
    + 'finished is never charged twice.' },
  { reason: 'dest_full', words: 'Leads is full (1,000,000 rows). Delete rows there, then Resume.' },
]) {
  test(`${c.reason} (put in place): the line shows the saved words, and Resume finishes the run`, async ({
    page, context,
  }) => {
    test.setTimeout(90_000)
    await freshTreg(api, { delayMs: 1500 })
    const { tableId, sheetId } = await seedLeadRows(api, LEADS)
    const runId = await startRun(api, sheetId, findRun())
    expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'pause' } })).ok()).toBeTruthy()
    await waitRun(api, runId, ['paused'])
    putPause('http_runs', runId, c.reason, c.words)
    expect((await listed(api, 'http', sheetId, runId))!.pause_message).toBe(c.words)
    expect((await runStatus(api, runId)).pauseReason).toBe(c.reason)
    await mockTreg.set({ delayMs: 0 })
    await openSheet(page, context, api, tableId)
    await expectLine(page, runId, COLUMN, c.words)
    await resumeLine(page, runId)
    await finishes(page, runId)
  })
}

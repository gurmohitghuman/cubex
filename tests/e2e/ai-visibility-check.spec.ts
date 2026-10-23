import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { freshTreg, rowsOf, waitRun } from './helpers-enrich'
import { mockTreg, setTregKey } from './helpers-treg'
import { waitAdded } from './helpers-list'
import { call, callError, mcpClient } from './helpers-mcp'

// "Check again" on an AI visibility table (services/ai-visibility-check*.ts)
// against the mock's AI engines: asked once, then checked again from the
// guide at 1280px while Gemini has started naming you: the answers of that day
// kept in dated copies of both sheets, "Named by on <day>" and "Change since
// <day>" after Named by, every question asked again, and the change column
// saying Up 1. Then MCP's estimate default (with its note for answers under
// three weeks old) and REST's scopes; and a check that couldn't ask (no treg
// key) stopping, then picked up by the next one without copying again.
// Screenshots land in test-results/shots/.

const INPUT = {
  brand: 'Acme CRM', competitors: ['Northdesk', 'Pipewell', 'Clientry'], domain: 'acme-crm.com',
  questions: ['Best CRM for a small team?', 'Cheapest CRM for two people?'],
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(v).slice(0, 400)}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

// A table asked once, every formula filled.
async function asked(api: APIRequestContext, input: Record<string, unknown> = INPUT) {
  const res = await api.post('/api/ai-visibility', { data: input })
  expect(res.ok(), await res.text()).toBeTruthy()
  const v = (await res.json()).aiVisibility
  const started = await (await api.post(`/api/ai-visibility/${v.id}/ask`, { data: {} })).json()
  for (const s of started.started) await waitRun(api, s.runId, ['completed'])
  await waitAdded(v.questionsSheetId)
  await until(() => rowsOf(api, v.questionsSheetId), r => r.every(x => x['Named by']), 'first answers')
  return v
}

test('check again from the guide: the answers kept, the change since then', async ({ page, context }) => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  for (const t of await (await api.get('/api/tables')).json()) await api.delete(`/api/tables/${t.id}`)
  const v = await asked(api)
  expect((await rowsOf(api, v.questionsSheetId)).map(r => r['Named by'])).toEqual(['2 of 4', '2 of 4'])

  const est = await (await api.post(`/api/ai-visibility/${v.id}/check`, { data: { estimateOnly: true } })).json()
  const day = est.plan.label
  expect(est.plan).toMatchObject({ soon: true, days: 0, questions: 2, names: {
    questionsCopy: `Questions ${day}`, sitesCopy: `Cited sites ${day}`, namedBy: `Named by on ${day}`,
    change: `Change since ${day}` } })
  expect(est.estimate.engines).toHaveLength(4)

  await mockTreg.set({ aiAlsoNames: { gemini: 'Acme CRM' } })
  await page.setViewportSize({ width: 1280, height: 800 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${v.tableId}/${v.questionsSheetId}`)
  const guide = page.getByTestId('ai-visibility-guide')
  await guide.getByTestId('ai-visibility-check').click()
  const confirm = page.getByTestId('ai-visibility-check-confirm')
  await expect(confirm).toContainText(`Keeps the answers of ${day} in “Questions ${day}” and “Cited sites ${day}”`)
  await expect(confirm).toContainText('asks 4 engines all 2 questions again')
  await expect(confirm.getByTestId('ai-visibility-check-soon')).toContainText('These answers are from today.')
  await expect(confirm.getByTestId('ai-visibility-check-cost')).toContainText('from your treg balance')
  await page.screenshot({ path: 'test-results/shots/ai-visibility-check-confirm.png' })
  await confirm.getByTestId('ai-visibility-check-go').click()
  await expect(confirm).toBeHidden({ timeout: 30_000 })
  await expect(page.getByText(`Kept the answers of ${day}. Asking 4 engines again.`)).toBeVisible()

  const table = await (await api.get(`/api/tables/${v.tableId}`)).json()
  const sheets = table.sheets as Array<{ id: string; name: string }>
  expect(sheets.map(s => s.name)).toEqual(['Questions', `Questions ${day}`, 'Cited sites', `Cited sites ${day}`])
  const now = await until(() => rowsOf(api, v.questionsSheetId),
    r => r.every(x => x[`Change since ${day}`] === 'Up 1'), 'the change column')
  expect(now.map(r => [r['Named by'], r[`Named by on ${day}`]])).toEqual([['3 of 4', '2 of 4'], ['3 of 4', '2 of 4']])
  const kept = await rowsOf(api, sheets[1].id)
  expect(kept.map(r => r['Named by'])).toEqual(['2 of 4', '2 of 4'])
  expect(kept[0]['Gemini answer']).not.toContain('Acme CRM')
  expect(now[0]['Gemini answer']).toContain('Acme CRM')
  expect((await rowsOf(api, sheets[3].id)).length).toBe(12)
  await waitAdded(v.questionsSheetId)
  expect((await rowsOf(api, v.sitesSheetId)).length).toBe(12)
  const sheet = await (await api.get(`/api/sheets/${v.questionsSheetId}`)).json()
  expect(sheet.data.columns.slice(0, 4)).toEqual(['Question', 'Named by', `Change since ${day}`, `Named by on ${day}`])
  expect(sheet.data.aiVisibility.checks[0]).toMatchObject({ label: day, stage: 'done' })
  await page.reload()
  await expect(page.getByTestId('ai-visibility-last-check'))
    .toContainText(`Last check: the answers of ${day} are kept; Change since ${day} says what moved.`)
  await expect(page.locator('.ag-cell').filter({ hasText: 'Up 1' }).first()).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: 'test-results/shots/ai-visibility-check-done.png' })
  await api.dispose()
})

test('MCP and REST: check_again is an estimate unless told otherwise, and needs the run scope', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const v = await asked(api, { ...INPUT, engines: ['chatgpt'], questions: ['Best CRM?'] })
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e aiv check'))
  const est = await call(client, 'ai_visibility', { action: 'check_again', id: v.questionsSheetId })
  expect(est).toMatchObject({ estimate_only: true, answers_days_old: 0, questions: 1,
    will_make: { questions_copy: `Questions ${est.answers_of}`, change_column: `Change since ${est.answers_of}` } })
  expect(est.note).toContain('within three weeks')
  expect((await (await api.get(`/api/tables/${v.tableId}`)).json()).sheets).toHaveLength(2)

  const writer = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'e2e aiv check w')}` }
  expect((await api.post(`/api/v1/ai-visibility/${v.id}/check-again`, { headers: writer, data: {} })).status())
    .toBe(403)
  const runner = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'run'], 'e2e aiv check r')}` }
  const rest = await (await api.post(`/api/v1/ai-visibility/${v.id}/check-again`, { headers: runner, data: {} }))
    .json()
  expect(rest.estimate_only).toBe(true)

  // Slow answers: the run it starts is still going when a second check comes.
  await mockTreg.set({ delayMs: 2_000 })
  const done = await call(client, 'ai_visibility', { action: 'check_again', id: v.id, estimate_only: false })
  expect(done).toMatchObject({ stage: 'done', answers_of: est.answers_of, problems: [] })
  expect(done.runs).toHaveLength(1)
  expect(await callError(client, 'ai_visibility', { action: 'check_again', id: v.id, estimate_only: false }))
    .toBe('ChatGPT is still being asked: check again once it\'s done.')
  await mockTreg.set({ delayMs: 0 })
  await waitRun(api, done.runs[0].run_id, ['completed'])
  const got = await call(client, 'ai_visibility', { action: 'ask', id: v.id })
  expect(got.estimate_only).toBe(true)
  const sheet = await call(client, 'get_sheet', { sheet_id: v.questionsSheetId })
  expect(sheet.columns).toContain(`Change since ${est.answers_of}`)
  await api.dispose()
})

test('a check that can\'t ask stops, and the next one picks it up without copying again', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const v = await asked(api, { ...INPUT, engines: ['chatgpt', 'gemini'], questions: ['Best CRM?'] })
  await setTregKey(api, null)
  const stopped = await (await api.post(`/api/ai-visibility/${v.id}/check`, { data: {} })).json()
  expect(stopped.check).toMatchObject({ stage: 'stopped', runs: [] })
  expect(stopped.check.problems.join(' ')).toContain('Check again picks up here')
  const tabs = async () => ((await (await api.get(`/api/tables/${v.tableId}`)).json()).sheets as
    Array<{ name: string }>).map(s => s.name)
  const day = stopped.check.label
  expect(await tabs()).toEqual(['Questions', `Questions ${day}`, 'Cited sites', `Cited sites ${day}`])

  await freshTreg(api)
  const est = await (await api.post(`/api/ai-visibility/${v.id}/check`, { data: { estimateOnly: true } })).json()
  expect(est.plan).toMatchObject({ picksUp: stopped.check.id, engines: ['ChatGPT', 'Gemini'],
    names: { questionsCopy: `Questions ${day}` } })
  const done = await (await api.post(`/api/ai-visibility/${v.id}/check`, { data: {} })).json()
  expect(done.check).toMatchObject({ id: stopped.check.id, stage: 'done', problems: [] })
  expect(done.check.runs.map((r: { column: string }) => r.column)).toEqual(['ChatGPT', 'Gemini'])
  expect(await tabs()).toEqual(['Questions', `Questions ${day}`, 'Cited sites', `Cited sites ${day}`])
  for (const r of done.check.runs) await waitRun(api, r.runId, ['completed'])
  const sheet = await (await api.get(`/api/sheets/${v.questionsSheetId}`)).json()
  expect(sheet.data.columns.filter((c: string) => c.startsWith('Change since'))).toEqual([`Change since ${day}`])
  await until(() => rowsOf(api, v.questionsSheetId), r => r[0][`Change since ${day}`] === 'Same', 'the change')
  await api.dispose()
})

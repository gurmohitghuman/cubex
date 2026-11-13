import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi } from './helpers'
import { callEveryRow, freshTreg, seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'
import { expectLine, listed, openSheet, pausedLine, putPause } from './helpers-paused'

// Waterfall runs that paused themselves, on the sheet (components/sheet/PausedRunsNotice.tsx): the line under
// the header names the column and says why and what to change. At its run limit it offers Open, the waterfall
// drawer, whose raise carries the run on; otherwise its Resume does. An AI step refused by OpenRouter for the
// fake key pauses the run for real (ai_key), and asks again on Resume. A formula step too slow (too_slow), a
// lookup step whose source is gone (setup) and OpenRouter out of credits (ai_credits) are put in place in the
// test database as the runner writes them: this harness can't bring them about without a real account.
const rx = new Receiver()
let api: APIRequestContext
const COLUMN = 'Work email'
const CSV = ['Name,Website', 'Maya Chen,https://stripe.com', 'Nobody Here,nobody.example', 'Ada Lane,ada.example']
  .join('\n')

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => { await rx.start(); api = await authedApi() })
test.afterAll(async () => { await rx.stop(); await api.delete('/api/settings/openrouter-key') })

const body = (over: Record<string, unknown> = {}) => ({
  columnName: COLUMN, resultType: 'email', fresh: true,
  inputs: [
    { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
    { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
  ],
  steps: [
    { label: 'treg finder', choices: { kind: 'enrichment', toolId: 'treg.people.email.find' } },
    { label: 'Own API', choices: { kind: 'http', method: 'GET', url: rx.url('/wf-find?d={{domain}}', 'wf'),
      valuePath: '$.email' } },
  ],
  ...over,
})
const statusOf = async (runId: string) => (await (await api.get(`/api/waterfall/runs/${runId}`)).json())
async function waitFor(runId: string, statuses: string[], timeoutMs = 30_000) {
  await expect.poll(async () => { const s = await statusOf(runId); return s.starting ? '' : s.status },
    { timeout: timeoutMs }).toMatch(new RegExp(`^(${statuses.join('|')})$`))
  return statusOf(runId)
}
async function start(sheetId: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body(over) })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).runId
}
const resumeLine = (page: Page, runId: string) =>
  pausedLine(page, runId).getByRole('button', { name: `Resume ${COLUMN}` }).click()
async function finishes(page: Page, runId: string) {
  await waitFor(runId, ['completed'], 60_000)
  await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
}

test("spend_limit: the line offers Open; the drawer's raise carries the run on", async ({ page, context }) => {
  test.setTimeout(90_000)
  await freshTreg(api)
  rx.on('/wf-find', { status: 200, body: '{"email":"own@example.com"}' })
  const { tableId, sheetId } = await seedCsv(api, CSV)
  const est = await (await api.post(`/api/waterfall/sheets/${sheetId}/estimate`, { data: body() })).json()
  const runId = await start(sheetId, { spendLimitUsd: est.per_row.max_usd })
  expect((await waitFor(runId, ['paused'])).pause_reason).toBe('spend_limit')
  await openSheet(page, context, api, tableId)
  const line = await expectLine(page, runId, COLUMN, /spend limit/)
  await expect(line.getByRole('button', { name: /Resume/ })).toHaveCount(0)
  await line.getByRole('button', { name: 'Open' }).click()
  await page.getByLabel('New run limit').fill('1')
  await page.getByTestId('waterfall-raise-resume').click()
  await finishes(page, runId)
})

test('ai_key: an AI step refused for the key; the line says so, and Resume asks OpenRouter again', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  await freshTreg(api)
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-sheet-paused-wf' } })).ok())
    .toBeTruthy()
  const { tableId, sheetId } = await seedCsv(api, CSV)
  const runId = await start(sheetId, { steps: [{ label: 'Ask AI', choices: { kind: 'ai',
    prompt: 'Find the work email of /full_name at /domain', model: 'openai/gpt-4o-mini' } }] })
  const paused = await waitFor(runId, ['paused'], 60_000)
  expect(paused.pause_reason).toBe('ai_key')
  await openSheet(page, context, api, tableId)
  await expectLine(page, runId, COLUMN, 'OpenRouter refused the AI step:')
  const before = (await listed(api, 'http', sheetId, runId))!.updated_at
  await resumeLine(page, runId)
  // The key is still fake: the run goes again, OpenRouter refuses again, and the line comes back.
  await expect.poll(async () => {
    const r = (await listed(api, 'http', sheetId, runId))!
    return r.status === 'paused' && r.pause_reason === 'ai_key' && r.updated_at !== before
  }, { timeout: 60_000 }).toBe(true)
  await expectLine(page, runId, COLUMN, 'OpenRouter refused the AI step:')
  expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'cancel' } })).ok()).toBeTruthy()
  await expect(pausedLine(page, runId)).toBeHidden({ timeout: 15_000 })
})

for (const c of [
  { reason: 'too_slow', words: 'Step "Score": its formula took too long on a row (over 2 s), so the run paused. '
    + 'Make the formula simpler, then Resume.' },
  { reason: 'setup', words: 'Step "Owner": its lookup sheet "Accounts" was deleted. Pick another sheet in the '
    + 'step, then Resume.' },
  { reason: 'ai_credits', words: 'OpenRouter refused the AI step: Insufficient credits. Add more at '
    + 'openrouter.ai/settings/credits (402)' },
]) {
  test(`${c.reason} (put in place): the line shows the saved words, and Resume finishes the run`, async ({
    page, context,
  }) => {
    test.setTimeout(90_000)
    await freshTreg(api, { delayMs: 1500 })
    rx.on('/wf-find', { status: 200, body: '{"email":"own@example.com"}' })
    const { tableId, sheetId } = await seedCsv(api, CSV)
    const runId = await start(sheetId)
    expect((await api.post(`/api/http/jobs/${runId}/control`, { data: { action: 'pause' } })).ok()).toBeTruthy()
    await waitFor(runId, ['paused'])
    putPause('http_runs', runId, c.reason, c.words)
    expect((await statusOf(runId)).message).toBe(c.words)
    await openSheet(page, context, api, tableId)
    await expectLine(page, runId, COLUMN, c.words)
    await resumeLine(page, runId)
    await finishes(page, runId)
  })
}

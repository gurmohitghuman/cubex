import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { callEveryRow, expectBilledOnce, freshTreg, ledger, readDb, rowsOf, seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'

// Waterfall columns through the app's routes (the same services REST and MCP
// call): a row walks its steps (a treg waterfall tool, a single treg tool, an
// HTTP API on a local receiver) and stops at the first answer; a row with no
// inputs for any step isn't taken; the result, "answered by" and step cells,
// the stored trace, the per-step counts and the ledger (each treg key billed
// once) say the same thing.
const rx = new Receiver()   // its own host: GET answers are cached by URL, and other specs ask /find too
let api: APIRequestContext

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => { await rx.start(); api = await authedApi() })
test.afterAll(async () => { await rx.stop(); await api?.dispose() })

const CSV = ['Name,Website', 'Maya Chen,https://stripe.com', 'Nobody Here,nobody.example', ','].join('\n')

export function waterfallBody(over: Record<string, unknown> = {}) {
  return {
    columnName: 'Work email', resultType: 'email',
    inputs: [
      { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
      { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
    ],
    steps: [
      { label: 'treg finder', choices: { kind: 'enrichment', toolId: 'treg.people.email.find' } },
      { label: 'Hunter', choices: { kind: 'enrichment', toolId: 'hunter.people.email.find' } },
      {
        label: 'Own API',
        choices: { kind: 'http', method: 'GET', url: rx.url('/find?d={{domain}}', 'run'), valuePath: '$.email' },
      },
    ],
    ...over,
  }
}

async function waitWaterfall(runId: string, statuses: string[], timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const s = await (await api.get(`/api/waterfall/runs/${runId}`)).json()
    if (statuses.includes(s.status) && !s.starting) return s
    if (Date.now() > until) throw new Error(`run ${runId} is ${s.status} (${s.message ?? ''})`)
    await new Promise(r => setTimeout(r, 300))
  }
}

test('each row stops at its first answer; cells, trace, counts and the ledger agree', async () => {
  await freshTreg(api)
  rx.on('/find', { status: 200, body: JSON.stringify({ email: 'nobody.here@nobody.example' }) })
  const { sheetId } = await seedCsv(api, CSV)

  const est = await api.post(`/api/waterfall/sheets/${sheetId}/estimate`, { data: waterfallBody() })
  const e = await est.json()
  expect(est.ok(), JSON.stringify(e)).toBeTruthy()
  expect(e.per_row.max_usd).toBeGreaterThan(0)
  expect(e.per_row.average_usd).toBeLessThanOrEqual(e.per_row.max_usd)
  expect(e.steps.map((s: { label: string }) => s.label)).toEqual(['treg finder', 'Hunter', 'Own API'])
  expect(e.steps[0].reach).toBe(1)

  const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: waterfallBody() })
  const started = await res.json()
  expect(res.ok(), JSON.stringify(started)).toBeTruthy()
  const s = await waitWaterfall(started.runId, ['completed'])
  expect(s.total_rows).toBe(2)
  expect(s.skipped_rows).toBe(1)

  const rows = await rowsOf(api, sheetId)
  expect(rows[0]['Work email']).toBe('maya.chen@stripe.com')
  expect(rows[0]['Work email (Answered by)']).toBe('treg finder')
  expect(rows[0]['Work email (Hunter)'] ?? '').toBe('')
  expect(rows[1]['Work email']).toBe('nobody.here@nobody.example')
  expect(rows[1]['Work email (Answered by)']).toBe('Own API')
  expect(rows[1]['Work email (treg finder)']).toBe('⏭️ Not found')
  expect(rows[1]['Work email (Hunter)']).toBe('⏭️ Not found')
  expect(rows[2]['Work email'] ?? '').toBe('')
  // Only the row the treg steps missed called the API.
  expect(rx.hitsOn('/find').map(h => h.query.get('d'))).toEqual(['nobody.example'])

  // Step counts: every step reached by the rows the earlier ones missed.
  const byLabel = Object.fromEntries(s.steps.map((x: { label: string }) => [x.label, x]))
  expect(byLabel['treg finder']).toMatchObject({ reached: 2, answered: 1 })
  expect(byLabel['Hunter']).toMatchObject({ reached: 1, answered: 0 })
  expect(byLabel['Own API']).toMatchObject({ reached: 1, answered: 1 })

  const traceUrl = `/api/waterfall/sheets/${sheetId}/trace?column=${encodeURIComponent('Work email')}&row=1`
  const trace = await (await api.get(traceUrl)).json()
  expect(trace.answeredBy).toBe('Own API')
  expect(trace.steps.map((x: { outcome?: string }) => x.outcome)).toEqual(['not_found', 'not_found', 'answered'])

  // Step columns start hidden in every view; the result and "answered by" don't.
  const hidden = readDb(db => db.prepare('SELECT hidden_columns FROM sheet_views WHERE sheet_id = ?').all(sheetId)) as
    Array<{ hidden_columns: string | null }>
  expect(hidden.length).toBeGreaterThan(0)
  for (const v of hidden) {
    expect(JSON.parse(v.hidden_columns ?? '[]').sort()).toEqual(
      ['Work email (Hunter)', 'Work email (Own API)', 'Work email (treg finder)'])
  }
  // Each treg key billed once, and the ledger holds every charge.
  await expectBilledOnce([started.runId])
  expect(ledger(started.runId).every(c => c.idempotency_key.includes(':ws'))).toBeTruthy()
})

test('running the empty rows again takes only the row with no result, which still has no inputs', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const first = await (await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: waterfallBody() })).json()
  await waitWaterfall(first.runId, ['completed'])
  const est = await (await api.post(`/api/waterfall/sheets/${sheetId}/reruns`,
    { data: { column: 'Work email', status: 'not_enriched', estimateOnly: true } })).json()
  expect(est.estimate.rows).toBe(1)
  const again = await api.post(`/api/waterfall/sheets/${sheetId}/reruns`,
    { data: { column: 'Work email', status: 'not_enriched' } })
  expect(again.ok()).toBeTruthy()
  const s = await waitWaterfall((await again.json()).started.runId, ['completed'])
  expect(s).toMatchObject({ total_rows: 0, skipped_rows: 1 })
  const failed = await api.post(`/api/waterfall/sheets/${sheetId}/reruns`,
    { data: { column: 'Work email', status: 'failed' } })
  expect(failed.status()).toBe(400)
  expect((await failed.json()).nothingToRun).toBe(true)
  const setup = await (await api.get(`/api/waterfall/sheets/${sheetId}/column-setup?column=Work%20email`)).json()
  expect(setup.input.steps.map((x: { label: string }) => x.label)).toEqual(['treg finder', 'Hunter', 'Own API'])
  expect(setup.columns.answeredBy).toBe('Work email (Answered by)')
})

test('retrying failed rows asks again only the step that failed, not the paid miss before it', async () => {
  await freshTreg(api)
  rx.on('/retry-find', { status: 500, body: '{"error":"down"}' },
    { status: 200, body: JSON.stringify({ email: 'nobody.here@nobody.example' }) })
  const { sheetId } = await seedCsv(api, 'Name,Website\nNobody Here,nobody.example')
  const body = waterfallBody({
    steps: [
      { label: 'Hunter', choices: { kind: 'enrichment', toolId: 'hunter.people.email.find' } },
      { label: 'Own API', choices: {
        kind: 'http', method: 'GET', url: rx.url('/retry-find?d={{domain}}', 'retry'), valuePath: '$.email', retries: 0,
      } },
    ],
  })
  const first = await (await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body })).json()
  await waitWaterfall(first.runId, ['completed'])
  expect((await rowsOf(api, sheetId))[0]['Work email']).toMatch(/^❌/)
  // Hunter's miss was paid for.
  expect(ledger(first.runId).map(c => c.cost_micro ?? 0).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)

  const again = await api.post(`/api/waterfall/sheets/${sheetId}/reruns`,
    { data: { column: 'Work email', status: 'failed' } })
  expect(again.ok()).toBeTruthy()
  const retry = (await again.json()).started.runId
  await waitWaterfall(retry, ['completed'])
  expect(ledger(retry)).toHaveLength(0)
  const rows = await rowsOf(api, sheetId)
  expect(rows[0]['Work email']).toBe('nobody.here@nobody.example')
  expect(rows[0]['Work email (Answered by)']).toBe('Own API')
  const trace = await (await api.get(`/api/waterfall/sheets/${sheetId}/trace?column=Work%20email&row=0`)).json()
  expect(trace.steps[0]).toMatchObject({ label: 'Hunter', outcome: 'not_found', from: 'last_run', cost_usd: 0 })
  expect(trace.steps[1]).toMatchObject({ label: 'Own API', outcome: 'answered' })
})

test('a run paused at its limit resumes with a higher one', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const est = await (await api.post(`/api/waterfall/sheets/${sheetId}/estimate`, { data: waterfallBody() })).json()
  // Room for one row at its most: the second pauses the run.
  const body = waterfallBody({ spendLimitUsd: est.per_row.max_usd })
  const started = await (await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body })).json()
  const paused = await waitWaterfall(started.runId, ['paused', 'completed'])
  expect(paused).toMatchObject({ status: 'paused', pause_reason: 'spend_limit' })
  expect(paused.max_per_row_usd).toBe(est.per_row.max_usd)
  const low = await api.post(`/api/waterfall/runs/${started.runId}/resume`, { data: { spendLimitUsd: -1 } })
  expect(low.status()).toBe(400)
  const res = await api.post(`/api/waterfall/runs/${started.runId}/resume`, { data: { spendLimitUsd: 1 } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const done = await waitWaterfall(started.runId, ['completed'])
  expect(done.run_limit_usd).toBe(1)
  expect(done.processed_rows).toBe(2)
})

test('a start refuses a step it can never run, an unknown key, and a missing OpenRouter key', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const post = (body: Record<string, unknown>) => api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body })
  let r = await post(waterfallBody({ inputs: [{ key: 'full_name', label: 'Name', source: { column: 'Name' } }] }))
  expect(r.status()).toBe(400)
  expect((await r.json()).error).toMatch(/map a column/i)
  r = await post({ ...waterfallBody(), estimateOnly: true })
  expect(r.status()).toBe(400)
  expect((await r.json()).error).toMatch(/Unknown argument estimateOnly/)
  r = await post(waterfallBody({
    steps: [{
      choices: { kind: 'ai', prompt: 'Find the work email of /full_name at /domain', model: 'openai/gpt-4o-mini' },
    }],
  }))
  expect([400, 409]).toContain(r.status())
})

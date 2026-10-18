import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { callEveryRow, freshTreg, ledger, rowsOf, seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'

// Formula steps and checks: a free formula guesses an address, treg's email
// verify checks it (the mock calls an address with "risky" in it risky, which
// "safest" rejects) so the next step answers that row; a formula check rejects
// a value from another domain; a dry run's verify is replayed by the real run.
const rx = new Receiver()
let api: APIRequestContext

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => { await rx.start(); api = await authedApi() })
test.afterAll(async () => { await rx.stop(); await api?.dispose() })

const GUESS = "{{full_name}}.toLowerCase().replace(' ', '.') + '@' + {{domain}}"
const inputs = [
  { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
  { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
]
const api_ = (path: string) => ({
  label: 'Own API', choices: { kind: 'http', method: 'GET', url: rx.url(`${path}?d={{domain}}`, 'checks'),
    valuePath: '$.email', retries: 0 },
})
const body = (steps: unknown[], over: Record<string, unknown> = {}) =>
  ({ columnName: 'Work email', resultType: 'email', inputs, steps, fresh: true, ...over })

async function runDone(runId: string) {
  await expect.poll(async () => {
    const s = await (await api.get(`/api/waterfall/runs/${runId}`)).json()
    return s.status === 'completed' ? s.status : `${s.status}: ${s.message ?? ''}`
  }, { timeout: 30_000 }).toBe('completed')
}
const traceOf = async (sheetId: string, row: number) =>
  (await api.get(`/api/waterfall/sheets/${sheetId}/trace?column=Work%20email&row=${row}`)).json()

test('a formula guesses, an email verify rejects a risky guess, and the next step answers', async () => {
  await freshTreg(api)
  rx.on('/backup', { status: 200, body: JSON.stringify({ email: 'backup@risky.example' }) })
  const { sheetId } = await seedCsv(api, 'Name,Website\nMaya Chen,stripe.com\nRisky Person,risky.example')
  const steps = [
    { id: 'sguess1', label: 'Guess', choices: { kind: 'formula', formula: GUESS },
      check: { kind: 'verify', accept: 'safest' } },
    api_('/backup'),
  ]
  const off = { label: 'Off', on: false, choices: { kind: 'formula', formula: GUESS }, check: { kind: 'verify' } }
  const est = await (await api.post(`/api/waterfall/sheets/${sheetId}/estimate`,
    { data: body([...steps, off]) })).json()
  expect(est.steps[0].max_usd).toBeGreaterThan(0)          // the formula is free; its verify isn't
  expect(est.steps[2]).toMatchObject({ on: false, reach: null })
  expect(est.steps[2].max_usd).toBeGreaterThan(0)          // a step switched off still shows what it costs
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body(steps) })
  const run = await res.json()
  expect(res.ok(), JSON.stringify(run)).toBeTruthy()
  await runDone(run.runId)
  const rows = await rowsOf(api, sheetId)
  expect(rows[0]['Work email']).toBe('maya.chen@stripe.com')
  expect(rows[0]['Work email (Answered by)']).toBe('Guess')
  expect(rows[1]['Work email']).toBe('backup@risky.example')
  expect(rows[1]['Work email (Answered by)']).toBe('Own API')
  const t = await traceOf(sheetId, 1)
  expect(t.steps[0]).toMatchObject({ outcome: 'rejected', value: 'risky.person@risky.example' })
  expect(t.steps[0].check).toMatchObject({ outcome: 'failed', verdict: 'risky' })
  expect(t.steps[1].outcome).toBe('answered')
  // One verify call per row, each under the step's own check attempt.
  const calls = ledger(run.runId)
  expect(calls).toHaveLength(2)
  expect(calls.every(c => c.attempt === 'wsguess1.c1')).toBeTruthy()
})

test('a formula check rejects a value from another domain', async () => {
  await freshTreg(api)
  rx.on('/other', { status: 200, body: JSON.stringify({ email: 'someone@elsewhere.example' }) })
  const { sheetId } = await seedCsv(api, 'Name,Website\nDana Lee,acme.example')
  const steps = [{ ...api_('/other'), check: { kind: 'formula', formula: "{{value}}.endsWith('@' + {{domain}})" } }]
  const run = await (await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body(steps) })).json()
  await runDone(run.runId)
  expect((await rowsOf(api, sheetId))[0]['Work email']).toBe('⏭️ Not found')
  const t = await traceOf(sheetId, 0)
  expect(t.steps[0]).toMatchObject({ outcome: 'rejected' })
  expect(t.steps[0].check).toMatchObject({ outcome: 'failed', verdict: 'false' })
  // A check formula naming something that isn't an input is refused at the start.
  const bad = await api.post(`/api/waterfall/sheets/${sheetId}/runs`,
    { data: body([{ ...api_('/other'), check: { kind: 'formula', formula: '{{nope}} > 1' } }]) })
  expect(bad.status()).toBe(400)
})

test('the real run replays a dry run\'s verify for free', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, 'Name,Website\nOwen Park,parkco.example')
  const steps = [{ id: 'sguess2', label: 'Guess', choices: { kind: 'formula', formula: GUESS },
    check: { kind: 'verify', accept: 'safest' } }]
  const dry = await (await api.post(`/api/waterfall/sheets/${sheetId}/dry-runs`,
    { data: body(steps, { dry: true }) })).json()
  await expect.poll(async () => (await (await api.get(`/api/waterfall/dry-runs/${dry.runId}`)).json()).run.status,
    { timeout: 30_000 }).toBe('completed')
  expect(ledger(dry.runId)).toHaveLength(1)
  // A second dry run (or Test this step again) pays for nothing it already checked.
  const again = await (await api.post(`/api/waterfall/sheets/${sheetId}/dry-runs`,
    { data: body(steps, { dry: true, fresh: false }) })).json()
  await expect.poll(async () => (await (await api.get(`/api/waterfall/dry-runs/${again.runId}`)).json()).run.status,
    { timeout: 30_000 }).toBe('completed')
  expect(ledger(again.runId)).toHaveLength(0)
  const run = await (await api.post(`/api/waterfall/sheets/${sheetId}/runs`,
    { data: body(steps, { fresh: false }) })).json()
  await runDone(run.runId)
  expect(ledger(run.runId)).toHaveLength(0)
  expect((await rowsOf(api, sheetId))[0]['Work email']).toBe('owen.park@parkco.example')
  expect((await traceOf(sheetId, 0)).steps[0].check).toMatchObject({ outcome: 'passed', cost_usd: 0, from: 'dry_run' })
})

test('two steps finding the same address pay for one verify; a retry re-buys no rejected value', async () => {
  await freshTreg(api)
  rx.on('/flaky', { status: 500, body: '{"error":"down"}' },
    { status: 200, body: JSON.stringify({ email: 'person@risky.example' }) })
  const { sheetId } = await seedCsv(api, 'Name,Website\nRisky Person,risky.example')
  const steps = [
    { id: 'sstrict', label: 'Strict', choices: { kind: 'formula', formula: GUESS },
      check: { kind: 'verify', accept: 'safest' } },
    { id: 'sloose1', label: 'Loose', choices: { kind: 'formula', formula: GUESS },
      check: { kind: 'verify', accept: 'wide' } },
  ]
  // The same guess twice: "safest" rejects the risky address, "wide" takes it from the same verdict.
  const one = await (await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body(steps) })).json()
  await runDone(one.runId)
  expect((await rowsOf(api, sheetId))[0]['Work email (Answered by)']).toBe('Loose')
  expect(ledger(one.runId)).toHaveLength(1)
  const t = await traceOf(sheetId, 0)
  expect(t.steps[1].check).toMatchObject({ outcome: 'passed', verdict: 'risky', cost_usd: 0 })

  // A rejected guess, then an API that fails: the row fails. Retried, the guess and its
  // verify are not paid for again; only the API is asked.
  const { sheetId: s2 } = await seedCsv(api, 'Name,Website\nRisky Person,risky.example')
  const failing = [steps[0], api_('/flaky')]
  // Not fresh: a rerun keeps the column's settings, and a fresh one asks everything again.
  const first = await (await api.post(`/api/waterfall/sheets/${s2}/runs`,
    { data: body(failing, { fresh: false }) })).json()
  await runDone(first.runId)
  expect((await rowsOf(api, s2))[0]['Work email']).toMatch(/^❌/)
  const again = await api.post(`/api/waterfall/sheets/${s2}/reruns`,
    { data: { column: 'Work email', status: 'failed' } })
  expect(again.ok()).toBeTruthy()
  const retry = (await again.json()).started.runId
  await runDone(retry)
  expect(ledger(retry)).toHaveLength(0)
  expect((await rowsOf(api, s2))[0]['Work email']).toBe('person@risky.example')
  // The kept guess comes back and its verify is judged again from the kept verdict, both at $0.
  const t2 = await traceOf(s2, 0)
  expect(t2.steps[0]).toMatchObject({ outcome: 'rejected', from: 'last_run', cost_usd: 0 })
  expect(t2.steps[0].check).toMatchObject({ outcome: 'failed', verdict: 'risky', cost_usd: 0 })
})

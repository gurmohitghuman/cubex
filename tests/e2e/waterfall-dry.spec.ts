import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, getSheet } from './helpers'
import { callEveryRow, freshTreg, ledger, rowsOf, seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'

// A dry run (#14) through the app's routes: it takes the first rows a step
// can run on, calls for real, writes nothing to the sheet (no column, no
// cell), shows each row's trace, and a real run afterwards replays what it
// bought at $0 (no new treg call; a free HTTP step is asked again). "Test this step" runs one step alone.
const rx = new Receiver()
let api: APIRequestContext

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => {
  await rx.start(); api = await authedApi()
  rx.on('/dry-find', { status: 200, body: JSON.stringify({ email: 'nobody.here@nobody.example' }) })
})
test.afterAll(async () => { await rx.stop(); await api?.dispose() })

const CSV = ['Name,Website', 'Maya Chen,https://stripe.com', 'Nobody Here,nobody.example', ','].join('\n')
const body = (over: Record<string, unknown> = {}) => ({
  columnName: 'Work email', resultType: 'email',
  inputs: [
    { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
    { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
  ],
  steps: [
    { id: 'sfinder', label: 'treg finder', choices: { kind: 'enrichment', toolId: 'treg.people.email.find' } },
    { id: 'sownapi', label: 'Own API', choices: {
      kind: 'http', method: 'GET', url: rx.url('/dry-find?d={{domain}}', 'dry'), valuePath: '$.email',
    } },
  ],
  ...over,
})

async function dryDone(runId: string) {
  let view: any
  await expect.poll(async () => {
    view = await (await api.get(`/api/waterfall/dry-runs/${runId}`)).json()
    return view.run.status
  }, { timeout: 30_000 }).toBe('completed')
  return view
}

test('a dry run writes nothing, shows each row, and the real run replays it at $0', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const before = (await getSheet(api, sheetId)).data.columns
  // fresh: other specs' dry runs bought the same lookups (kept answers are account-wide).
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/dry-runs`, { data: body({ dry: true, fresh: true }) })
  const started = await res.json()
  expect(res.status(), JSON.stringify(started)).toBe(202)
  // The empty third row has no inputs for any step: not taken.
  expect(started.rowIndexes).toEqual([0, 1])
  const view = await dryDone(started.runId)
  expect(view.rows.map((r: any) => [r.value, r.answered_by])).toEqual([
    ['maya.chen@stripe.com', 'treg finder'], ['nobody.here@nobody.example', 'Own API'],
  ])
  expect(view.rows[0].inputs).toMatchObject({ full_name: 'Maya Chen' })
  expect(view.rows[1].steps.map((s: any) => s.outcome)).toEqual(['not_found', 'answered'])
  // Nothing in the sheet: no new column, no cell.
  expect((await getSheet(api, sheetId)).data.columns).toEqual(before)
  expect((await rowsOf(api, sheetId))[0]['Work email']).toBeUndefined()
  const dryCalls = ledger(started.runId).length
  expect(dryCalls).toBeGreaterThan(0)
  const apiHits = rx.hitsOn('/dry-find').length

  // The real run: the treg answers come from the dry run, for nothing (the API, a free
  // step, is asked again: its GET answer comes from the 5-minute response cache here).
  const run = await (await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body() })).json()
  await expect.poll(async () => (await (await api.get(`/api/waterfall/runs/${run.runId}`)).json()).status,
    { timeout: 30_000 }).toBe('completed')
  expect(ledger(run.runId)).toHaveLength(0)
  expect(rx.hitsOn('/dry-find').length).toBeLessThanOrEqual(apiHits + 1)
  const rows = await rowsOf(api, sheetId)
  expect(rows[0]['Work email']).toBe('maya.chen@stripe.com')
  expect(rows[1]['Work email (Answered by)']).toBe('Own API')
  const trace = await (await api.get(`/api/waterfall/sheets/${sheetId}/trace?column=Work%20email&row=0`)).json()
  expect(trace.steps[0]).toMatchObject({ outcome: 'answered', from: 'dry_run', cost_usd: 0 })
})

test('Test this step runs that step alone on the rows', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/dry-runs`,
    { data: body({ dry: { only: 'sownapi' }, fresh: true }) })
  const started = await res.json()
  expect(res.status(), JSON.stringify(started)).toBe(202)
  const view = await dryDone(started.runId)
  expect(view.only).toEqual({ id: 'sownapi', label: 'Own API' })
  expect(view.steps.map((s: any) => s.label)).toEqual(['Own API'])
  expect(view.rows.every((r: any) => r.steps.length === 1 && r.steps[0].label === 'Own API')).toBeTruthy()
  // No treg step ran.
  expect(ledger(started.runId)).toHaveLength(0)
  // A step id the waterfall doesn't have is refused.
  const bad = await api.post(`/api/waterfall/sheets/${sheetId}/dry-runs`, { data: body({ dry: { only: 'snosuch' } }) })
  expect(bad.status()).toBe(400)
})

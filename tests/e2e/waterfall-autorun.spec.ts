import { test, expect } from '@playwright/test'
import { authedApi } from './helpers'
import { callEveryRow, freshTreg, rowsOf } from './helpers-enrich'
import { autorunOf, autorunRuns, byName, seedViaWebhook, setAutorun, sleep, waitRow } from './helpers-autorun'
import { Receiver } from './helpers-receiver'

// Auto-run on a waterfall column: rows a webhook adds walk the same steps on
// their own (a treg tool, then an HTTP API on a local receiver), filling the
// result and "answered by"; the column's daily cap is in dollars (it has a
// paid step), and a cap below what one row can cost pauses auto-run instead
// of running.
const rx = new Receiver()
const COL = 'Work email'
const BY = 'Work email (Answered by)'
// Done: the result cell no longer holds the run's ⏳ placeholder ("answered by" holds one too).
const done = (r: Record<string, string>) => !!r[BY] && !r[BY].startsWith('⏳') && !(r[COL] ?? '').startsWith('⏳')

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => { await rx.start() })
test.afterAll(async () => { await rx.stop() })

test('webhook rows fill through the waterfall; a cap below a row pauses it', async () => {
  test.setTimeout(90_000)
  rx.on('/auto-find', { status: 200, body: JSON.stringify({ email: 'nobody.here@nobody.example' }) })
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId, deliver } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  const body = {
    columnName: COL, resultType: 'email',
    inputs: [
      { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
      { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
    ],
    steps: [
      { label: 'treg finder', choices: { kind: 'enrichment', toolId: 'treg.people.email.find' } },
      { label: 'Own API', choices: {
        kind: 'http', method: 'GET', url: rx.url('/auto-find?d={{domain}}', 'auto'), valuePath: '$.email',
      } },
    ],
  }
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body })
  const started = await res.json()
  expect(res.ok(), JSON.stringify(started)).toBeTruthy()
  await expect.poll(async () => (await (await api.get(`/api/waterfall/runs/${started.runId}`)).json()).status,
    { timeout: 30_000 }).toBe('completed')
  expect((await rowsOf(api, sheetId)).find(byName('Maya Chen'))?.[COL]).toBe('maya.chen@stripe.com')

  const set = await setAutorun(api, sheetId, { column: COL, enabled: true, dailyCapUsd: 1 })
  expect(JSON.stringify(set)).not.toContain('error')

  // treg finds nothing for this one: the next step answers.
  await deliver({ Name: 'Nobody Here', Website: 'nobody.example' })
  const nobody = await waitRow(api, sheetId, byName('Nobody Here'), done)
  expect(nobody[COL]).toBe('nobody.here@nobody.example')
  expect(nobody[BY]).toBe('Own API')
  // A row treg answers stops there.
  await deliver({ Name: 'Ada Lovelace', Website: 'figma.com' })
  const ada = await waitRow(api, sheetId, byName('Ada Lovelace'), done)
  expect(ada[COL]).toContain('@figma.com')
  expect(ada[BY]).toBe('treg finder')
  expect(autorunRuns(sheetId).length).toBeGreaterThan(0)

  // A cap below the most one row can cost: auto-run pauses instead of running.
  await setAutorun(api, sheetId, { column: COL, enabled: true, dailyCapUsd: 0.0001 })
  const before = autorunRuns(sheetId).length
  await deliver({ Name: 'Grace Hopper', Website: 'airtable.com' })
  await expect.poll(async () => (await autorunOf(api, sheetId, COL)).pausedReason, { timeout: 10_000 })
    .toBe('column_cap')
  await sleep(1500)
  expect(autorunRuns(sheetId).length).toBe(before)
  expect((await rowsOf(api, sheetId)).find(byName('Grace Hopper'))?.[COL] ?? '').toBe('')
  await api.dispose()
})

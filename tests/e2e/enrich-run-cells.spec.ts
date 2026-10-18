import { test, expect } from '@playwright/test'
import { authedApi } from './helpers'
import { mockTreg } from './helpers-treg'
import {
  callEveryRow, expectBilledOnce, freshTreg, ledger, mockBilling, resultsOf, rowsOf, seedCsv, seedLeadRows, startRun,
  waitRun,
} from './helpers-enrich'

// What enrichment cells say and cost (plan Verification 6, 15, 19, 20, 29):
// budget ran out, an unreachable treg, the same lookup made once, rows without
// their inputs, and a cancelled run's paid answers recovered by the rerun.

const findRun = (over: Record<string, unknown> = {}) => ({
  toolId: 'treg.people.email.find', preset: null, columnName: 'Find email', continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
  rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false, ...over,
})
const calls = async (tool: string) => (await mockTreg.requests()).filter(r => r.path === `/call/${tool}`)
callEveryRow()

test('over the per-row budget: "Budget ran out", nothing charged', async () => {
  const api = await authedApi()
  await freshTreg(api, { findMisses: { 'capped.example': 99 } })
  const { sheetId } = await seedLeadRows(api, [{ Name: 'Ada Lovelace', Website: 'capped.example' }, { Name: 'Grace Hopper', Website: 'acme.example' }])
  // A cap that lets only the two cheapest providers try (both miss here)...
  const capped = await startRun(api, sheetId, findRun({ maxCostPerRowUsd: 0.006 }))
  await waitRun(api, capped, ['completed'])
  // ...and one below the cheapest provider: treg refuses it (402 route_max_cost).
  const refused = await startRun(api, sheetId, findRun({ columnName: 'Tiny budget', outputs: [], maxCostPerRowUsd: 0.000001 }))
  await waitRun(api, refused, ['completed'])
  const [ada, grace] = await rowsOf(api, sheetId)
  expect(ada['Find email']).toBe('⏭️ Budget ran out')
  expect(ada.Email).toBe('')
  expect(grace['Find email']).toBe('✅ Found')
  expect(ada['Tiny budget']).toBe('⏭️ Budget ran out')
  expect(grace['Tiny budget']).toBe('⏭️ Budget ran out')
  expect(resultsOf(refused).every(r => r.cost_usd === 0)).toBe(true)
  await expectBilledOnce([capped, refused])
  await api.dispose()
})

test('treg unreachable: the run pauses after 5 failures and rows stay ⏳', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, Array.from({ length: 6 }, (_, i) => ({ Name: `Lead Person${i}`, Website: `co${i}.example` })))
  // The tool details are cached by the server first, so the start itself works.
  expect((await api.get('/api/enrich/tools/treg.people.email.find')).ok()).toBeTruthy()
  await mockTreg.set({ down: true })
  const runId = await startRun(api, sheetId, findRun())
  const paused = await waitRun(api, runId, ['paused'], 20_000)
  expect(paused.pauseReason).toBe('unreachable')
  expect(paused.message).toContain("Can't reach treg")
  expect((await rowsOf(api, sheetId)).every(r => r['Find email'] === '⏳ Processing...')).toBe(true)
  await mockTreg.set({ down: false })
  expect((await api.post(`/api/enrich/runs/${runId}/resume`, { data: {} })).ok()).toBeTruthy()
  await waitRun(api, runId, ['completed'])
  expect((await rowsOf(api, sheetId)).every(r => r['Find email'] === '✅ Found')).toBe(true)
  await api.dispose()
})

test('the same lookup is one call: 20 rows at 3 companies', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const sites = ['https://alpha.example/about', 'alpha.example', 'www.beta.example', 'beta.example', 'gamma.example']
  const { sheetId } = await seedLeadRows(api, Array.from({ length: 20 }, (_, i) => ({ Name: `Lead ${i}`, Website: sites[i % sites.length] })))
  const runId = await startRun(api, sheetId, {
    ...findRun({ toolId: 'treg.companies.enrich', columnName: 'Company data' }),
    inputs: { domain: { column: 'Website' } }, outputs: [{ key: 'name', path: '$.output.name', columnName: 'Company name' }],
  })
  const done = await waitRun(api, runId, ['completed'])
  expect(await calls('treg.companies.enrich')).toHaveLength(3)
  expect((await rowsOf(api, sheetId)).every(r => r['Company data'] === '✅ Found' && r['Company name'] !== '')).toBe(true)
  const results = resultsOf(runId)
  const shared = results.filter(r => typeof r.response?._cubex?.same_as_row_index === 'number')
  expect(shared).toHaveLength(17)
  expect(shared.every(r => r.cost_usd === 0)).toBe(true)
  expect(done.spentUsd).toBeCloseTo((await mockBilling()).reduce((s, b) => s + b.costMicro, 0) / 1e6, 6)
  await expectBilledOnce([runId])
  await api.dispose()
})

test('rows without their inputs get no status; filled later, the next run takes them', async () => {
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, [
    { Name: 'Ada Lovelace', Website: 'acme.example' }, { Name: 'Grace Hopper', Website: '' }, { Name: 'Alan Turing', Website: '' },
  ])
  const runId = await startRun(api, sheetId, findRun())
  const done = await waitRun(api, runId, ['completed'])
  expect(done.totalRows).toBe(1)
  expect(done.skippedRows).toBe(2)
  let rows = await rowsOf(api, sheetId)
  expect(rows.map(r => r['Find email'] ?? '')).toEqual(['✅ Found', '', ''])
  expect(await calls('treg.people.email.find')).toHaveLength(1)
  // Fill one Website, then add to the same column: only that row runs.
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: [{ rowIndex: 1, columnName: 'Website', value: 'navy.example' }] } })).ok()).toBeTruthy()
  const more = await startRun(api, sheetId, findRun({ continueColumn: true }))
  expect((await waitRun(api, more, ['completed'])).totalRows).toBe(1)
  rows = await rowsOf(api, sheetId)
  expect(rows.map(r => r['Find email'] ?? '')).toEqual(['✅ Found', '✅ Found', ''])
  await expectBilledOnce([runId, more])
  // The HTTP column rerun can't clone an enrichment (it would skip its checks).
  const rerun = await api.post('/api/http/rerun', { data: { sheetId, masterColumnName: 'Find email' } })
  expect(rerun.status()).toBe(400)
  expect((await rerun.json()).error).toBe('Run enrichments again from the Enrichment button.')
  await api.dispose()
})

test('cancel mid-batch, then run again: paid single-tool answers come back free', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api, { delayMs: 2000 })
  const { sheetId } = await seedCsv(api, ['Email', 'ada@acme.example', 'grace@acme.example', 'alan@acme.example'].join('\n'))
  const body = (over: Record<string, unknown> = {}) => ({
    ...findRun({ toolId: 'millionverifier.people.email.verify', columnName: 'Checked', ...over }),
    inputs: { email: { column: 'Email' } }, outputs: [{ key: 'result', path: '$.result', columnName: 'Result' }],
  })
  const first = await startRun(api, sheetId, body())
  await expect.poll(async () => (await calls('millionverifier.people.email.verify')).length, { timeout: 15_000 }).toBe(3)
  expect((await api.post(`/api/http/jobs/${first}/control`, { data: { action: 'cancel' } })).ok()).toBeTruthy()
  // The calls in flight finish and are recorded (treg billed them).
  await expect.poll(() => ledger(first).filter(c => (c.cost_micro ?? 0) > 0).length, { timeout: 10_000 }).toBe(3)
  await mockTreg.set({ delayMs: 0 })
  const again = await startRun(api, sheetId, body({ continueColumn: true }))
  await waitRun(api, again, ['completed'])
  expect((await rowsOf(api, sheetId)).every(r => r.Checked === '✅ Found' && r.Result === 'ok')).toBe(true)
  expect(await calls('millionverifier.people.email.verify')).toHaveLength(3)
  expect(ledger(again).every(c => c.replay === 1 && c.cost_micro === 0)).toBe(true)
  expect(await mockBilling()).toHaveLength(3)
  await api.dispose()
})

import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { MOCK_TEAM_KEY, mockTreg, setTregKey } from './helpers-treg'
import { expectBilledOnce, freshTreg, ledger, rowsOf, runStatus, seedLeadRows, startRun, waitRun } from './helpers-enrich'

// What stops an enrichment run and how it carries on (plan Verification 3, 4,
// 5 and 30): a pause mid-batch, the run's spend limit, the treg balance, and
// the key removed mid-run. Calls in flight always finish and are recorded, and
// a resume re-sends the same keys, so the mock bills each key once.

const LEADS = Array.from({ length: 8 }, (_, i) => ({ Name: `Lead Person${i}`, Website: `co${i}.example` }))

// A plain waterfall: one find per row, the email and who found it.
const findRun = (over: Record<string, unknown> = {}) => ({
  toolId: 'treg.people.email.find', preset: null, columnName: 'Find email', continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }, { key: 'found_by', path: '$._treg.served_by', columnName: 'Found by' }],
  rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false, ...over,
})

const control = (api: APIRequestContext, runId: string, action: string) => api.post(`/api/http/jobs/${runId}/control`, { data: { action } })
const resume = (api: APIRequestContext, runId: string, spendLimitUsd?: number) =>
  api.post(`/api/enrich/runs/${runId}/resume`, { data: spendLimitUsd === undefined ? {} : { spendLimitUsd } })
async function firstCall() {
  await expect.poll(async () => (await mockTreg.requests()).filter(r => r.path.startsWith('/call/')).length, { timeout: 15_000 }).toBeGreaterThan(0)
}
const allFound = async (api: APIRequestContext, sheetId: string, n: number) =>
  expect((await rowsOf(api, sheetId)).filter(r => r['Find email'] === '✅ Found')).toHaveLength(n)

test('pause mid-batch, resume: in-flight answers replay for free', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api, { delayMs: 1500 })
  const { sheetId } = await seedLeadRows(api, LEADS)
  const runId = await startRun(api, sheetId, findRun())
  await firstCall()
  expect((await control(api, runId, 'pause')).ok()).toBeTruthy()
  await waitRun(api, runId, ['paused'])
  // Let the calls in flight finish: treg bills them; Cubex records them, keeps the rows ⏳.
  await expect.poll(() => ledger(runId).length, { timeout: 10_000 }).toBe(5)
  expect((await rowsOf(api, sheetId)).filter(r => r['Find email'] === '⏳ Processing...')).toHaveLength(8)
  expect((await resume(api, runId)).ok()).toBeTruthy()
  await waitRun(api, runId, ['completed'], 60_000)
  await allFound(api, sheetId, 8)
  expect(ledger(runId).filter(c => c.replay === 1)).toHaveLength(5)
  await expectBilledOnce([runId])
  await api.dispose()
})

test('the spend limit pauses the run; raising it carries on', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS.slice(0, 6))
  const runId = await startRun(api, sheetId, findRun({ maxCostPerRowUsd: 0.01, spendLimitUsd: 0.02 }))
  const paused = await waitRun(api, runId, ['paused'])
  expect(paused.pauseReason).toBe('spend_limit')
  expect(paused.message).toContain('$0.02 spend limit')
  expect(paused.spentUsd).toBeLessThanOrEqual(0.02)
  expect((await resume(api, runId, 1)).ok()).toBeTruthy()
  const done = await waitRun(api, runId, ['completed'])
  expect(done.spendLimitUsd).toBe(1)
  expect(done.pauseReason).toBeNull()
  await allFound(api, sheetId, 6)
  await expectBilledOnce([runId])
  await api.dispose()
})

test('an empty treg balance pauses with the top-up message', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api, { balanceMicro: 6000 })
  const { sheetId } = await seedLeadRows(api, LEADS.slice(0, 3))
  const runId = await startRun(api, sheetId, findRun())
  const paused = await waitRun(api, runId, ['paused'])
  expect(paused.pauseReason).toBe('balance')
  expect(paused.message).toContain('Your treg balance ran out')
  expect(paused.message).toContain('Top up at treg, then Resume.')
  // Topped up: the refused rows try again under a new key (treg keeps a refusal per key).
  await mockTreg.set({ balanceMicro: 1_000_000 })
  expect((await resume(api, runId)).ok()).toBeTruthy()
  await waitRun(api, runId, ['completed'])
  await allFound(api, sheetId, 3)
  expect(ledger(runId).some(c => c.attempt === 't1.2')).toBe(true)
  await expectBilledOnce([runId])
  await api.dispose()
})

test('removing the key mid-run pauses it; adding it back carries on', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api, { delayMs: 1500 })
  const { sheetId } = await seedLeadRows(api, LEADS)
  const runId = await startRun(api, sheetId, findRun())
  await firstCall()
  await setTregKey(api, null)
  const paused = await waitRun(api, runId, ['paused'], 20_000)
  expect(paused.pauseReason).toBe('no_key')
  expect(paused.message).toBe('No treg key. Add one in Settings, then Resume.')
  await setTregKey(api, MOCK_TEAM_KEY)
  expect((await resume(api, runId)).ok()).toBeTruthy()
  await waitRun(api, runId, ['completed'], 60_000)
  await allFound(api, sheetId, 8)
  expect((await runStatus(api, runId)).rows.completed).toBe(8)
  await expectBilledOnce([runId])
  await api.dispose()
})

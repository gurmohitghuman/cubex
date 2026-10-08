import { test, expect } from '@playwright/test'
import { authedApi } from './helpers'
import { freshTreg, startRun, verifiedEmailRun, waitRun } from './helpers-enrich'
import { autorunRuns, byName, seedViaWebhook, setAutorun, waitRow } from './helpers-autorun'

// Auto-run adds a run per batch of rows, so a busy column has many runs. The
// sheet's run list (GET /api/http/runs, read on every load) stays bounded:
// the active runs plus the newest run of each column (Verification 18).

test('the runs list stays bounded after 50 auto-runs', async () => {
  test.setTimeout(240_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId, deliver } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun()), ['completed'])
  await setAutorun(api, sheetId, { column: 'Work email', enabled: true, dailyCapUsd: 5 })
  for (let i = 0; i < 50; i++) {
    await deliver({ Name: `Person ${i}`, Website: 'stripe.com' })
    await waitRow(api, sheetId, byName(`Person ${i}`), r => (r['Work email'] ?? '').startsWith('✅'))
  }
  expect(autorunRuns(sheetId).length).toBe(50)
  const res = await api.get('/api/http/runs', { params: { sheetId } })
  expect(res.ok()).toBeTruthy()
  const runs = await res.json() as Array<{ id: string; master_column_name: string }>
  expect(runs).toHaveLength(1)
  expect(runs[0].id).toBe(autorunRuns(sheetId).at(-1)!.id)
  await api.dispose()
})

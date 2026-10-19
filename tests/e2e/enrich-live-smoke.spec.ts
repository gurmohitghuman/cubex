import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { setTregKey } from './helpers-treg'
import { ledger, rowsOf, seedLeadRows, startRun, verifiedEmailRun, waitRun } from './helpers-enrich'

// The live smoke (plan Verification): 2 rows of Verified work email against
// the real treg with the team key in CUBEX_SMOKE_TREG_TOKEN. It spends cents
// of that team's balance (each row capped at $0.03, the run at $0.06), so the
// harness runs it alone:
//   CUBEX_SMOKE_TREG_TOKEN=$(cat <key file>) E2E_SPEC=tests/e2e/enrich-live-smoke.spec.ts npm run e2e
// What Cubex's ledger recorded must equal the drop in treg's balance, to the
// micro-dollar. Skipped without the token. Never log the token.

const TOKEN = process.env.CUBEX_SMOKE_TREG_TOKEN
test.skip(!TOKEN, 'live smoke: set CUBEX_SMOKE_TREG_TOKEN (see scripts/e2e-harness.mjs)')

// Fictional people at real company domains.
const LEADS = [{ Name: 'Maya Chen', Website: 'stripe.com' }, { Name: 'Leo Martins', Website: 'notion.so' }]

async function balance(api: APIRequestContext): Promise<{ micro: number; heldMicro: number }> {
  const res = await api.get('/api/enrich/balance')
  expect(res.ok(), 'treg balance read').toBeTruthy()
  const b = await res.json() as { balanceUsd: number; onHoldUsd: number }
  return { micro: Math.round(b.balanceUsd * 1e6), heldMicro: Math.round(b.onHoldUsd * 1e6) }
}

test('2 rows of Verified work email: the ledger equals the balance delta', async () => {
  test.setTimeout(240_000)
  const api = await authedApi()
  await setTregKey(api, TOKEN!)
  const check = await (await api.post('/api/settings/test-treg-key', { data: {} })).json()
  expect(check.valid, check.message).toBe(true)
  // Wait for any hold from an earlier use of the key to settle before reading the start.
  await expect.poll(async () => (await balance(api)).heldMicro, { timeout: 60_000 }).toBe(0)
  const before = (await balance(api)).micro

  const { sheetId } = await seedLeadRows(api, LEADS)
  const runId = await startRun(api, sheetId, verifiedEmailRun({ maxCostPerRowUsd: 0.03, spendLimitUsd: 0.06 }))
  const s = await waitRun(api, runId, ['completed', 'paused', 'failed'], 180_000)
  expect(s.status, s.message ?? '').toBe('completed')

  const calls = ledger(runId)
  const spent = calls.reduce((sum, c) => sum + (c.cost_micro ?? 0), 0)
  expect(spent).toBeLessThanOrEqual(60_000)
  expect(Math.round(s.spentUsd * 1e6)).toBe(spent)
  // treg's balance includes holds for calls in flight and can lag a moment.
  await expect.poll(async () => {
    const b = await balance(api)
    return b.heldMicro === 0 ? before - b.micro : null
  }, { timeout: 90_000, intervals: [1000, 2000, 5000] }).toBe(spent)

  // The spend card and /api/health agree.
  const card = await (await api.get('/api/enrich/spend?days=7')).json()
  expect(Math.round(card.totalUsd * 1e6)).toBe(spent)
  expect((await (await api.get('/api/health')).json()).treg).toBe('ok')
  const rows = await rowsOf(api, sheetId)
  expect(rows.every(r => /^(✅|⏭️)/.test(r['Work email'] ?? ''))).toBe(true)
  console.log(`live smoke: ${calls.length} calls, ledger ${spent} micro = balance delta`)

  await setTregKey(api, null)
  await api.dispose()
})

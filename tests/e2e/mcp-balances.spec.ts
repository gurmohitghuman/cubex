import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'
import { freshTreg } from './helpers-enrich'
import { call, mcpClient } from './helpers-mcp'

// get_balances (and GET /v1/balances): the treg balance and daily limit, and
// OpenRouter's part, each answering on its own; run_ai_column's estimate
// reports what the run holds on OpenRouter's in-flight budget at its concurrency.
// No OpenRouter key is saved here, so its part says so instead of a figure.

test('get_balances reads treg and OpenRouter on their own, and costs nothing', async () => {
  const api = await authedApi()
  await freshTreg(api)
  await api.delete('/api/settings/openrouter-key')
  const token = await makeAccessToken(api, ['read'], 'e2e balances')
  const client = await mcpClient(token)

  const b = await call(client, 'get_balances', {})
  expect(typeof b.treg.balance_usd).toBe('number')
  expect(typeof b.treg.on_hold_usd).toBe('number')
  expect(b.enrichment_daily_limit).toHaveProperty('limit_usd')
  expect(b.openrouter.connected).toBe(false)
  expect(b.openrouter.error).toContain('OpenRouter key')

  // The same read over REST; a token is required.
  const v1 = await api.get(`${BASE}/api/v1/balances`, { headers: { Authorization: `Bearer ${token}` } })
  expect(v1.status()).toBe(200)
  const body = await v1.json()
  expect(body.treg.balance_usd).toBe(b.treg.balance_usd)
  expect(body.openrouter.connected).toBe(false)
  expect((await api.get(`${BASE}/api/v1/balances`)).status()).toBe(401)
  await client.close()
  await api.dispose()
})

test('estimate_only reports the in-flight hold at the run\'s concurrency', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e in-flight'))
  const est = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Note', prompt: 'Say /val', model: 'openai/gpt-4o-mini',
    concurrency: 40, estimate_only: true,
  })
  // Only when OpenRouter's public catalog priced the model.
  if (est.pricing_available) {
    expect(est.in_flight.concurrency).toBe(40)
    expect(est.in_flight.reserve_per_call_usd).toBeGreaterThan(0)
    expect(est.in_flight.reserve_at_concurrency_usd).toBeCloseTo(est.in_flight.reserve_per_call_usd * 40, 3)
    // No key saved: OpenRouter said nothing about the balance, so no warning.
    expect(est.in_flight.account_balance_usd).toBeNull()
    expect(est.in_flight.warning).toBeUndefined()
  }
  await client.close()
  await api.dispose()
})

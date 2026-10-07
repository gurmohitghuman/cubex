import { request as pwRequest, APIRequestContext, expect } from '@playwright/test'
import { importCsv } from './helpers'

// The mock treg (tests/mock-treg) that scripts/e2e-harness.sh starts and points
// the server at (TREG_BASE_URL). Specs set its state (balance, the team's own
// provider keys) and read which requests Cubex made.
export const TREG = process.env.E2E_TREG || 'http://127.0.0.1:3098'

// The mock takes any key starting treg_mock_ as a team key. The server caches a
// tool's access (own keys, free routes) for 5 minutes per key, so a spec that
// changes ownKeys/freeProviders after a drawer read should save its own key.
export const MOCK_TEAM_KEY = 'treg_mock_e2e_team_key'

export interface MockRequest { method: string; path: string; query: string; hasToken: boolean; headers: Record<string, string>; body: string }

async function withMock<T>(fn: (ctx: APIRequestContext) => Promise<T>): Promise<T> {
  const ctx = await pwRequest.newContext({ baseURL: TREG })
  try { return await fn(ctx) } finally { await ctx.dispose() }
}

export const mockTreg = {
  reset: () => withMock(async c => { expect((await c.post('/__mock/reset')).ok()).toBeTruthy() }),
  set: (patch: Record<string, unknown>) => withMock(async c => { expect((await c.post('/__mock/state', { data: patch })).ok()).toBeTruthy() }),
  requests: () => withMock(async c => (await (await c.get('/__mock/requests')).json()) as MockRequest[]),
}

export async function setTregKey(api: APIRequestContext, key: string | null) {
  const res = key === null ? await api.delete('/api/settings/treg-key') : await api.put('/api/settings/treg-key', { data: { apiKey: key } })
  expect(res.ok()).toBeTruthy()
}

// A fresh table whose sheet holds a small lead list (fictional people, real
// company domains; LinkedIn left empty on purpose).
export const LEADS_CSV = [
  'Name,Company,Website,LinkedIn,Title',
  'Maya Chen,Stripe,https://stripe.com,,Head of Growth',
  'Leo Martins,Notion,https://www.notion.so/about,,VP Sales',
  'Ava Patel,Figma,figma.com,,Design Lead',
].join('\n')

export async function seedLeads(api: APIRequestContext): Promise<{ tableId: string; sheetId: string }> {
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const table = await (await api.post('/api/tables', { data: { name: `Leads ${Date.now()}` } })).json()
  const sheetId = table.sheets[0].id as string
  const res = await importCsv(api, sheetId, LEADS_CSV, { replaceData: true, filename: 'leads.csv' })
  expect(res.ok()).toBeTruthy()
  return { tableId: table.id as string, sheetId }
}

import { APIRequestContext, expect, request as pwRequest } from '@playwright/test'
import path from 'path'
import { createRequire } from 'module'
import { importCsv } from './helpers'
import { TREG, MOCK_TEAM_KEY, mockTreg, setTregKey } from './helpers-treg'

// Enrichment run helpers: a lead sheet, run starts through the API (the same
// route the drawer calls), waiting on the lean status, and reading what the
// mock billed against Cubex's ledger.
const require = createRequire(import.meta.url)

export interface Lead { Name: string; Website: string }

// A fresh table (the one account's others removed) whose sheet holds `csv`.
export async function seedCsv(api: APIRequestContext, csv: string): Promise<{ tableId: string; sheetId: string }> {
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const table = await (await api.post('/api/tables', { data: { name: `Leads ${Date.now()}` } })).json()
  const sheetId = table.sheets[0].id as string
  expect((await importCsv(api, sheetId, csv, { replaceData: true, filename: 'leads.csv' })).ok()).toBeTruthy()
  return { tableId: table.id as string, sheetId }
}

export const seedLeadRows = (api: APIRequestContext, leads: Lead[]) =>
  seedCsv(api, ['Name,Website', ...leads.map(l => `${l.Name},${l.Website}`)].join('\n'))

// A fresh mock and the team key, before each run spec.
export async function freshTreg(api: APIRequestContext, state: Record<string, unknown> = {}) {
  await mockTreg.reset()
  await setTregKey(api, MOCK_TEAM_KEY)
  if (Object.keys(state).length) await mockTreg.set(state)
}

export const EMAIL_OUTPUTS = [
  { key: 'email', path: '$.output.email', columnName: 'Email' },
  { key: 'email_status', path: null, columnName: 'Email status' },
  { key: 'found_by', path: '$._treg.served_by', columnName: 'Found by' },
  { key: 'checked_by', path: null, columnName: 'Checked by' },
]

// Verified work email over Name + Website; override anything per spec.
export function verifiedEmailRun(over: Record<string, unknown> = {}) {
  return {
    toolId: 'treg.people.email.find', preset: 'verified_email', columnName: 'Work email', continueColumn: false,
    inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
    providerOrder: [], skipProviders: [], stopAtFirst: false,
    email: { accept: 'safest', guess: false, pattern: 'first.last' },
    outputs: EMAIL_OUTPUTS, rows: { mode: 'all', test: false }, conditions: [],
    maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false, ...over,
  }
}

export async function startRun(api: APIRequestContext, sheetId: string, body: Record<string, unknown>): Promise<string> {
  const res = await api.post(`/api/enrich/sheets/${sheetId}/runs`, { data: body })
  const json = await res.json()
  expect(res.ok(), JSON.stringify(json)).toBeTruthy()
  return json.runId as string
}

export async function runStatus(api: APIRequestContext, runId: string) {
  const res = await api.get(`/api/enrich/runs/${runId}`)
  expect(res.ok()).toBeTruthy()
  return res.json()
}

export async function waitRun(api: APIRequestContext, runId: string, statuses: string[], timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const s = await runStatus(api, runId)
    if (statuses.includes(s.status)) return s
    if (Date.now() > until) throw new Error(`run ${runId} is ${s.status} (${s.message ?? ''}), wanted ${statuses.join('/')}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

export async function rowsOf(api: APIRequestContext, sheetId: string): Promise<Array<Record<string, string>>> {
  const res = await api.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).data.rows as Array<{ data: Record<string, string> }>).map(r => r.data)
}

export async function mockBilling(): Promise<Array<{ key: string | null; toolId: string; costMicro: number }>> {
  const ctx = await pwRequest.newContext({ baseURL: TREG })
  try { return await (await ctx.get('/__mock/billing')).json() } finally { await ctx.dispose() }
}

export async function mockState(): Promise<Record<string, unknown>> {
  const ctx = await pwRequest.newContext({ baseURL: TREG })
  try { return await (await ctx.get('/__mock/state')).json() } finally { await ctx.dispose() }
}

function readDb<T>(fn: (db: any) => T): T {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set: run via scripts/e2e-harness.sh')
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(dbPath, { readonly: true })
  try { db.pragma('busy_timeout = 5000'); return fn(db) } finally { db.close() }
}

// Cubex's ledger for a run, read straight from the test DB (harness only).
export const ledger = (runId: string): Array<{ attempt: string; idempotency_key: string; cost_micro: number | null; http_status: number | null; replay: number; call_id: string | null }> =>
  readDb(db => db.prepare('SELECT attempt, idempotency_key, cost_micro, http_status, replay, call_id FROM enrichment_calls WHERE run_id = ? ORDER BY rowid').all(runId))

// No Idempotency-Key was billed twice, and Cubex's ledger holds what the mock billed.
export async function expectBilledOnce(runIds: string[]) {
  const billed = await mockBilling()
  const keys = billed.map(b => b.key)
  expect(new Set(keys).size, 'a key was billed twice').toBe(keys.length)
  const ledgerSum = runIds.flatMap(id => ledger(id)).reduce((s, c) => s + (c.cost_micro ?? 0), 0)
  expect(ledgerSum).toBe(billed.reduce((s, b) => s + b.costMicro, 0))
}

// A sheet's enrichment runs, oldest first, and one run's stored results.
export const runIdsOf = (sheetId: string): string[] =>
  readDb(db => db.prepare('SELECT id FROM http_runs WHERE sheet_id = ? ORDER BY rowid').pluck().all(sheetId))
export const resultsOf = (runId: string): Array<{ row_index: number; status: string; cost_usd: number | null; error_message: string | null; response: any }> =>
  readDb(db => (db.prepare('SELECT row_index, status, cost_usd, error_message, response_data FROM http_results WHERE run_id = ? ORDER BY row_index').all(runId) as any[])
    .map(r => ({ ...r, response: r.response_data ? JSON.parse(r.response_data) : null })))

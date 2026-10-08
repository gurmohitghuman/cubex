import fs from 'node:fs'
import { APIRequestContext, expect, request as pwRequest } from '@playwright/test'
import { readDb, rowsOf, seedCsv } from './helpers-enrich'

// Auto-run spec plumbing: turning a column's auto-run on, a webhook that adds
// rows from outside, waiting for cells, the auto-run runs in the test DB, and
// the harness's test clock (lib/clock.ts reads E2E_CLOCK_FILE as an offset).

export async function setAutorun(api: APIRequestContext, sheetId: string, body: Record<string, unknown>) {
  const res = await api.put(`/api/autorun/sheets/${sheetId}/columns`, { data: body })
  const json = await res.json()
  expect(res.ok(), JSON.stringify(json)).toBeTruthy()
  return json
}

export async function autorunOf(api: APIRequestContext, sheetId: string, column: string) {
  const res = await api.get(`/api/autorun/sheets/${sheetId}`)
  expect(res.ok()).toBeTruthy()
  return (await res.json()).columns[column]
}

// A webhook on the sheet mapping each field to a column of the same name; returns a deliverer.
export async function webhookOn(api: APIRequestContext, sheetId: string, fields: string[]) {
  const created = await api.post(`/api/sheets/${sheetId}/webhook`, { data: { name: 'auto-run e2e' } })
  expect(created.status()).toBe(201)
  const url: string = (await created.json()).source.url
  for (const f of fields) {
    expect((await api.post(`/api/sheets/${sheetId}/webhook/mappings`, {
      data: { jsonPath: `$.${f}`, columnName: f },
    })).ok()).toBeTruthy()
  }
  return async (payload: Record<string, string>) => {
    const anon = await pwRequest.newContext()
    try {
      const res = await anon.post(url, { headers: { 'Content-Type': 'application/json' }, data: payload })
      expect(res.ok()).toBeTruthy()
    } finally { await anon.dispose() }
  }
}

// A sheet whose leads come in through its webhook (a mapping always makes a
// new column, so Name and Website are the webhook's): one starter row (no
// inputs), then `leads` delivered. Returns the deliverer for more.
export async function seedViaWebhook(api: APIRequestContext, leads: Array<{ Name: string; Website: string }>) {
  const { tableId, sheetId } = await seedCsv(api, 'Note\nstarter row')
  const deliver = await webhookOn(api, sheetId, ['Name', 'Website'])
  for (const lead of leads) await deliver(lead)
  await expect.poll(async () => (await rowsOf(api, sheetId)).filter(r => r.Name).length).toBe(leads.length)
  return { tableId, sheetId, deliver }
}

// Polls the sheet until `pick` finds a row and `done` holds for it.
export async function waitRow(
  api: APIRequestContext, sheetId: string, pick: (r: Record<string, string>) => boolean,
  done: (r: Record<string, string>) => boolean, timeoutMs = 20_000,
): Promise<Record<string, string>> {
  let last: Record<string, string> | undefined
  await expect.poll(async () => {
    last = (await rowsOf(api, sheetId)).find(pick)
    return !!last && done(last)
  }, { timeout: timeoutMs }).toBe(true)
  return last!
}

export const byName = (name: string) => (r: Record<string, string>) => r.Name === name

export interface AutorunRun {
  id: string; status: string; total_rows: number; allow_secrets: number; pause_reason: string | null
}
export const autorunRuns = (sheetId: string): AutorunRun[] => readDb(db => db.prepare(
  `SELECT id, status, total_rows, allow_secrets, pause_reason FROM http_runs
    WHERE sheet_id = ? AND autorun_id IS NOT NULL ORDER BY rowid`).all(sheetId))

export async function waitAutorunActive(sheetId: string, timeoutMs = 15_000): Promise<AutorunRun> {
  let run: AutorunRun | undefined
  await expect.poll(() => {
    run = autorunRuns(sheetId).find(r => ['pending', 'running'].includes(r.status))
    return !!run
  }, { timeout: timeoutMs }).toBe(true)
  return run!
}

export async function waitNoActiveRun(sheetId: string, timeoutMs = 30_000) {
  await expect.poll(() => readDb(db => db.prepare(`SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?
    AND (status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)`).pluck().get(sheetId)),
  { timeout: timeoutMs }).toBe(0)
}

// Moves the server's "today" (daily limits, auto-run caps): ms from now.
export function moveClock(ms: number) {
  const file = process.env.E2E_CLOCK_FILE
  if (!file) throw new Error('E2E_CLOCK_FILE not set: run via scripts/e2e-harness.sh')
  if (ms === 0) fs.rmSync(file, { force: true })
  else fs.writeFileSync(file, String(ms))
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

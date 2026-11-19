import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { freshTreg, mockBilling, readDb, rowsOf, waitRun } from './helpers-enrich'
import { waitAdded } from './helpers-list'
import { mockTreg } from './helpers-treg'

// A hiring table (services/hiring-*.ts) against the mock's job search (tests/mock-treg/jobs.mjs): made with no
// paid call, estimated with no paid call (only the free counts), checked: the roles into Roles, a row per company
// in Companies (Quillmark's role with no domain joins it by name); checked again: only the two new roles added,
// a role deleted since stays out, the roles from before untouched, the two companies with new roles say so. A
// provider answering more roles than asked never makes a check spend more than its estimate.

const DOMAINS = ['bluefin-data.io', 'copperleaf-systems.io', 'harborview-health.io', 'northwind-labs.io',
  'quillmark.io']
const paidCalls = async () => (await mockTreg.requests()).map(r => r.path)
  .filter(p => p.startsWith('/call/') && !p.endsWith('.count'))

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(v).slice(0, 400)}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

export async function makeHiring(api: APIRequestContext, input: Record<string, unknown>) {
  const res = await api.post('/api/hiring', { data: input })
  expect(res.ok(), await res.text()).toBeTruthy()
  return res.json()
}
const hiring = async (api: APIRequestContext, id: string) => (await (await api.get(`/api/hiring/${id}`)).json()).hiring

// A check started and followed to its end: its run, its roles added, its summary.
async function check(api: APIRequestContext, h: { id: string; searchesSheetId: string }) {
  const res = await api.post(`/api/hiring/${h.id}/check`, { data: { timeZone: 'UTC' } })
  const started = await res.json()
  expect(res.ok(), JSON.stringify(started)).toBeTruthy()
  expect(started.check.stage).toBe('searching')
  await waitRun(api, started.check.runId, ['completed'])
  await waitAdded(h.searchesSheetId)
  const done = await until(() => hiring(api, h.id), v => ['done', 'stopped'].includes(v.checks[0].stage), 'check')
  return done.checks[0]
}

test('make, estimate, check, check again: only the new roles, what is new per company', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const made = await makeHiring(api, { roles: ['SDR', 'BDR'], country: 'US' })
  const h = made.hiring
  expect(made.name).toMatch(/^Hiring: SDR, BDR( \d+)?$/)
  expect(made.sheets.map((s: { name: string }) => s.name)).toEqual(['Companies', 'Roles', 'Searches'])
  expect((await rowsOf(api, h.searchesSheetId)).map(r => r['Role title'])).toEqual(['SDR', 'BDR'])
  expect(await paidCalls()).toEqual([])

  const est = await (await api.post(`/api/hiring/${h.id}/check`, { data: { estimateOnly: true } })).json()
  expect(est.estimate).toMatchObject({ searches: 2, rolesUpTo: 50, priceKnown: true,
    matches: { about: 240, counted: 2, capped: false } })
  expect(est.plan.since).toBeNull()
  expect(await paidCalls()).toEqual([])
  expect((await hiring(api, h.id)).checks).toEqual([])

  const first = await check(api, h)
  expect(first).toMatchObject({ stage: 'done', rolesAdded: 20, companiesNew: 5, companiesHiringMore: 0 })
  expect(first.problems).toEqual(['2 roles had no domain, so they were summed up by company name.'])
  const roles = await rowsOf(api, h.rolesSheetId)
  expect(roles).toHaveLength(20)
  expect(new Set(roles.map(r => r['First seen']))).toEqual(new Set([first.label]))
  expect(new Set(roles.map(r => r.Search))).toEqual(new Set(['SDR', 'BDR']))
  const companies = await rowsOf(api, h.companiesSheetId)
  expect(companies.map(c => c.Domain).sort()).toEqual(DOMAINS)
  expect(companies.reduce((n, c) => n + Number(c['Open roles']), 0)).toBe(20)
  expect(companies.find(c => c.Domain === 'quillmark.io')!['Open roles']).toBe('4')
  expect(companies.every(c => !c['New roles'] && c['First seen'] === first.label)).toBe(true)

  // The person deletes a role; the next search finds it again, and two new ones.
  const gone = roles.find(r => r.Search === 'SDR' && r.Company === 'Northwind Labs')!
  const index = readDb(db => db.prepare(`SELECT row_index FROM rows WHERE sheet_id = ?
    AND json_extract(data, '$.Link') = ?`).pluck().get(h.rolesSheetId, gone.Link)) as number
  const generation = (await (await api.get(`/api/sheets/${h.rolesSheetId}?limit=1`)).json()).sheet.row_generation
  const del = await api.post(`/api/sheets/${h.rolesSheetId}/rows/bulk-delete`,
    { data: { rowIndices: [index], rowGeneration: generation } })
  expect(del.ok(), await del.text()).toBeTruthy()
  const kept = (await rowsOf(api, h.rolesSheetId))
  await mockTreg.set({ jobsNew: { SDR: 2 } })

  const second = await check(api, h)
  expect(second).toMatchObject({ stage: 'done', since: first.label, rolesAdded: 2, companiesNew: 0,
    companiesHiringMore: 2 })
  const after = await rowsOf(api, h.rolesSheetId)
  expect(after).toHaveLength(21)
  expect(after.map(r => r.Link)).not.toContain(gone.Link)
  expect(after.slice(0, 19)).toEqual(kept)
  expect(after.slice(19).map(r => r['First seen'])).toEqual([second.label, second.label])
  const now = await rowsOf(api, h.companiesSheetId)
  const fresh = now.filter(c => Number(c['New roles']) > 0)
  expect(fresh.map(c => c.Domain).sort()).toEqual(['harborview-health.io', 'quillmark.io'])
  expect(fresh.find(c => c.Domain === 'harborview-health.io')!['New since last check'])
    .toMatch(/^New since \w{3} \d{1,2}: 1 role \(SDR\)$/)
  expect(now.filter(c => !fresh.includes(c)).every(c => !c['New roles'] && !c['New since last check'])).toBe(true)
  await api.dispose()
})

test('a provider answering more roles than asked: the check never spends more than its estimate', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api, { jobsOverfill: 5 })
  const h = (await makeHiring(api, { roles: ['Account Executive', 'RevOps Manager'], perSearch: 3 })).hiring
  const est = (await (await api.post(`/api/hiring/${h.id}/check`, { data: { estimateOnly: true } })).json()).estimate
  expect(est.highUsd).toBeGreaterThan(0)
  const done = await check(api, h)
  expect(done.stage).toBe('done')
  const runs = await (await api.get(`/api/enrich/runs/${done.runId}`)).json()
  expect(runs.spendLimitUsd).toBe(est.highUsd)
  const billed = (await mockBilling()).filter(b => b.toolId.includes('jobs.search') && !b.toolId.endsWith('.count'))
  expect(billed.length).toBe(2)
  const spent = billed.reduce((n, b) => n + b.costMicro, 0)
  expect(spent).toBeGreaterThan(0)
  expect(spent).toBeLessThanOrEqual(Math.round(est.highUsd * 1e6))
  // Each search adds at most its 3, though 8 came back.
  expect(await rowsOf(api, h.rolesSheetId)).toHaveLength(6)
  await api.dispose()
})

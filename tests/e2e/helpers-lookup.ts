import { expect, type APIRequestContext } from '@playwright/test'
import { seedSheet } from './helpers'

// Two sheets in two tables for the lookup specs: Leads (Name, Domain, Company)
// looks in Companies (Website, Firm, Industry). Matching ignores case and
// spaces; acme.com is in Companies twice (first: Robots).
export const LEADS = [
  { Name: 'Ada', Domain: 'ACME.com', Company: 'acme' },
  { Name: 'Bob', Domain: 'globex.com ', Company: 'Globex' },
  { Name: 'Cy', Domain: 'nowhere.io', Company: 'zz' },
]
export const COMPANIES = [
  { Website: 'acme.com', Firm: 'Acme Corporation', Industry: 'Robots' },
  { Website: 'GLOBEX.COM', Firm: 'Globex Holdings', Industry: 'Energy' },
  { Website: 'acme.com', Firm: 'Acme Labs', Industry: 'Research' },
  { Website: 'initech.com', Firm: 'Initech', Industry: 'Software' },
]

async function fill(api: APIRequestContext, sheetId: string, rows: Array<Record<string, string>>, have: number) {
  for (const c of Object.keys(rows[0])) {
    expect((await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: c } })).ok()).toBeTruthy()
  }
  if (rows.length > have) {
    const add = await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: rows.length - have } })
    expect(add.ok()).toBeTruthy()
  }
  const updates = rows.flatMap((r, i) =>
    Object.entries(r).map(([columnName, value]) => ({ rowIndex: i, columnName, value })))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
}

export async function seedLookupSheets(api: APIRequestContext) {
  const leads = await seedSheet(api, LEADS.length)
  await fill(api, leads.sheetId, LEADS, LEADS.length)
  const t = await (await api.post('/api/tables', { data: { name: `Accounts ${Date.now()}` } })).json()
  const companiesId = t.sheets[0].id as string
  expect((await api.patch(`/api/tables/${t.id}/sheets/${companiesId}`, { data: { name: 'Companies' } })).ok())
    .toBeTruthy()
  // A new sheet starts with blank rows of its own.
  const have = ((await (await api.get(`/api/sheets/${companiesId}?limit=100&offset=0`)).json()).data.rows as unknown[])
    .length
  await fill(api, companiesId, COMPANIES, have)
  return { leadsTable: leads.tableId, leadsId: leads.sheetId, companiesTable: t.id as string, companiesId }
}

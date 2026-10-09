import { APIRequestContext, expect } from '@playwright/test'
import { readDb, rowsOf, startRun, waitRun } from './helpers-enrich'

// List results into rows: a company sheet, "People at a company" run starts
// (the drawer's request), picking the fields from a test's results, and
// reading the destination sheet. The mock answers each provider's own rows
// (tests/mock-treg/lists.mjs): quickenrich's are first_name, last_name, title,
// employee_linkedin, company_url…; ten per company unless told otherwise.

export const PEOPLE_FIELDS = [
  { path: '$.first_name', columnName: 'First name' },
  { path: '$.last_name', columnName: 'Last name' },
  { path: '$.employee_linkedin', columnName: 'LinkedIn' },
]

// "People at a company" over the Website column, into `dest`.
export function peopleRun(dest: Record<string, unknown>, over: Record<string, unknown> = {},
  list: Record<string, unknown> = {}) {
  return {
    toolId: 'treg.people.search', preset: null, columnName: 'People', continueColumn: false,
    inputs: { company_domain: { column: 'Website' } }, cleanDomains: true,
    providerOrder: [], skipProviders: [], stopAtFirst: false, email: null, outputs: [],
    rows: { mode: 'all', status: 'any', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null,
    fresh: false,
    list: {
      dest, provider: 'quickenrich', maxItems: 3, fields: null, copy: [{ from: 'Company', to: 'Company' }],
      dedupePath: null, ...list,
    },
    ...over,
  }
}

export const companiesCsv = (rows: Array<[string, string]>) =>
  ['Company,Website', ...rows.map(([c, w]) => `${c},${w}`)].join('\n')

// A test on the first rows into a new sheet, then the fields picked from its
// results: the column is ready for full runs. Returns the run and the sheet.
export async function testAndPick(
  api: APIRequestContext, sheetId: string, destName: string, opts: { maxItems?: number; dedupe?: boolean } = {},
): Promise<{ runId: string; destId: string }> {
  const res = await api.post(`/api/enrich/sheets/${sheetId}/runs`, {
    data: peopleRun({ newSheetName: destName }, { rows: { mode: 'all', status: 'any', test: true } },
      { maxItems: opts.maxItems ?? 3 }),
  })
  const started = await res.json()
  expect(res.ok(), JSON.stringify(started)).toBeTruthy()
  await waitRun(api, started.runId, ['completed'])
  const pick = await api.post(`/api/enrich/sheets/${sheetId}/list-fields`, {
    data: { column: 'People', fields: PEOPLE_FIELDS, dedupePath: opts.dedupe ? '$.employee_linkedin' : null },
  })
  expect(pick.ok(), await pick.text()).toBeTruthy()
  return { runId: started.runId, destId: started.destSheetId }
}

// The rest of the column's rows (not enriched yet), with the fields picked.
export const runRest = (api: APIRequestContext, sheetId: string, destId: string,
  list: Record<string, unknown> = {}) => startRun(api, sheetId, peopleRun({ sheetId: destId }, {
  continueColumn: true, rows: { mode: 'all', status: 'not_enriched', test: false },
}, { fields: PEOPLE_FIELDS, ...list }))

// Every journal row of the sheet's list runs has become rows (or waits for something).
export async function waitAdded(sheetId: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const left = readDb(db => db.prepare(`SELECT COUNT(*) AS n FROM enrichment_list_items
      WHERE source_sheet_id = ? AND status = 'pending' AND wait_reason IS NULL`).get(sheetId) as { n: number }).n
    if (left === 0) return
    if (Date.now() > until) throw new Error(`${left} journal rows still pending`)
    await new Promise(r => setTimeout(r, 250))
  }
}

export const destRows = (api: APIRequestContext, destId: string) => rowsOf(api, destId)

import { expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { freshTreg, seedCsv, startRun, verifiedEmailRun, waitRun } from './helpers-enrich'
import type { Receiver } from './helpers-receiver'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'

// A sheet of 10,000 rows whose cells open each panel a click can (cell-panels*.spec.ts): an HTTP API column on its
// first 8 rows (Title), a verified-email enrichment and a waterfall (Found email) on their 5 test rows, and a
// "(Data)" column of sources summaries on every row.
export const PANEL_ROWS = 10_000

export async function seedCellPanels(rx: Receiver): Promise<{ api: APIRequestContext; tableId: string }> {
  rx.on('/cell-panels', { status: 200, body: JSON.stringify({ title: 'A title', meta: { page: 1, tags: ['a'] } }) })
  rx.on('/cell-panels-find', { status: 200, body: JSON.stringify({ email: 'found@panel.example' }) })
  const api = await authedApi()
  await freshTreg(api)
  const csv = ['Id,Name,Website,Research (Data)']
  for (let i = 1; i <= PANEL_ROWS; i++) csv.push(`${i},Person ${i},company${i}.example,📊 3 sources`)
  const { tableId, sheetId } = await seedCsv(api, csv.join('\n'))
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'cell panels'))
  // The HTTP API column on the first 8 rows, the enrichment and the waterfall on their 5 test rows.
  const first = await (await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { limit: 8 } })).json()
  const http = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url('/cell-panels?id={{Id}}'), response_mapping: [{ json_path: '$.title', column_name: 'Title' }],
    target_row_ids: first.rows.map((r: { id: string }) => r.id),
  } })
  expect(http.status(), await http.text()).toBe(202)
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${(await http.json()).run_id}`)).status).toBe('completed')
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun({ rows: { mode: 'all', test: true } })),
    ['completed'])
  const wf = await v1.post(`/api/v1/sheets/${sheetId}/waterfall-columns`, { data: {
    column_name: 'Found email', result_type: 'email', inputs: { full_name: 'Name', domain: 'Website' }, test: true,
    steps: [{ kind: 'http', label: 'Own API', url: rx.url('/cell-panels-find?d={{domain}}'), value_path: '$.email' }],
    estimate_only: false,
  } })
  expect(wf.status(), await wf.text()).toBe(202)
  const runId = (await wf.json()).run_id
  await expect.poll(async () => (await (await api.get(`/api/waterfall/runs/${runId}`)).json()).status,
    { timeout: 60_000 }).toBe('completed')
  return { api, tableId }
}

export async function openTable(page: Page, context: BrowserContext, api: APIRequestContext, tableId: string,
  width: number) {
  await page.setViewportSize({ width, height: 900 })
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
}
// A header reads its name, after a mapped column's 📎.
export async function colId(page: Page, name: string): Promise<string> {
  const ids = await page.locator('.ag-header-cell').evaluateAll((hs, n) => hs.filter(h => {
    const t = (h.textContent ?? '').trim()
    return t === n || t.replace(/^\S+\s/, '') === n
  }).map(h => h.getAttribute('col-id')), name)
  expect(ids.length, `the ${name} column`).toBeGreaterThan(0)
  return ids[0]!
}
export const cellOf = (page: Page, id: string, row: number) =>
  page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="${id}"]`).first()

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, seedSheet, importCsv, BASE } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'

// The filter panel and saved views: a draft made on one view never lands on
// another (switched in another tab while the panel is open), and a run-state
// rule kept on a column whose run is gone (its status column deleted) doesn't
// block other changes, nor reads through the view.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'filter panel views'))
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

const shownVals = async (page: Page) => (await page.locator('.ag-center-cols-container .ag-row').allInnerTexts())
  .map(t => t.split('\n').find(x => /^v\d$/.test(x.trim()))?.trim()).filter(Boolean).sort()
const rules = (page: Page) => page.getByTestId('filter-panel').getByTestId('filter-rule')
const viewsOf = async (sheetId: string) => (await (await v1.get(`/api/v1/sheets/${sheetId}/views`)).json())
  .views as Array<{ id: string; name: string; active: boolean; where: unknown[] }>
const whereOf = async (sheetId: string, name: string) => (await viewsOf(sheetId)).find(v => v.name === name)?.where
const open = async (page: Page, tableId: string) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.context().addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
}

test('a draft made on one view is never saved over another view', async ({ page }) => {
  const { tableId, sheetId } = await seedSheet(api, 6)
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'Plan' } })
  const plans = ['Pro', 'Free', 'Pro', 'Free', 'Team', 'Pro']
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: {
    updates: plans.map((value, rowIndex) => ({ rowIndex, columnName: 'Plan', value })) } })).ok()).toBeTruthy()
  // View B: Plan is free. Then back to Default (no filter).
  const free = [{ column: 'Plan', operator: 'eq', value: 'free' }]
  const b = (await (await api.post(`/api/sheets/${sheetId}/views`, { data: { name: 'B' } })).json()).view
  expect((await api.put(`/api/sheets/${sheetId}/filters`, { data: { where: free, viewId: b.id } })).ok()).toBeTruthy()
  const def = (await viewsOf(sheetId)).find(v => v.name === 'Default')!
  expect((await api.post(`/api/sheets/${sheetId}/views/${def.id}/activate`)).ok()).toBeTruthy()

  await open(page, tableId)
  await expect.poll(() => shownVals(page), { timeout: 15_000 }).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
  await page.getByTestId('filter-button').click()
  await page.getByTestId('filter-panel').getByRole('button', { name: 'Add rule' }).first().click()
  await rules(page).nth(0).getByLabel('Column').selectOption('Plan')
  await rules(page).nth(0).getByLabel('Condition').selectOption('eq')
  await rules(page).nth(0).getByLabel('Value').fill('pro')
  await rules(page).nth(0).getByLabel('Value').press('Enter')
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v2', 'v5'])

  // A change typed but not applied yet; meanwhile another tab shows view B.
  await rules(page).nth(0).getByLabel('Value').fill('team')
  expect((await api.post(`/api/sheets/${sheetId}/views/${b.id}/activate`)).ok()).toBeTruthy()
  await rules(page).nth(0).getByLabel('Value').press('Enter').catch(() => {})
  // The panel starts again on B's filter (the open tab learned of the switch,
  // or the save was refused for it), and B's filter is untouched.
  if (!await page.getByTestId('filter-panel').isVisible()) await page.getByTestId('filter-button').click()
  await expect(rules(page).nth(0).getByLabel('Value')).toHaveValue('free', { timeout: 15_000 })
  await expect(page.getByTestId('view-menu')).toHaveText(/B/)
  expect(await whereOf(sheetId, 'B')).toEqual(free)

  // The next change goes to B, built on B's filter; Default keeps its own.
  await rules(page).nth(0).getByRole('switch').click()
  await expect.poll(() => whereOf(sheetId, 'B')).toEqual([{ ...free[0], enabled: false }])
  await expect.poll(() => shownVals(page)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5'])
  expect(await whereOf(sheetId, 'Default')).toEqual([{ column: 'Plan', operator: 'eq', value: 'pro' }])
})

test('a run-state rule on a column that lost its run blocks no change', async ({ page }) => {
  rx.on('/who', { status: 200, body: '{"ok":"yes"}' })
  const { tableId, sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, 'val,Name\nv0,Ada\nv1,Bob\nv2,Cy\n', { replaceData: true })).ok())
    .toBeTruthy()
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url('/who?n={{Name}}'), master_column_name: 'Call',
    response_mapping: [{ json_path: '$.ok', column_name: 'OK' }] } })
  expect(res.status(), await res.text()).toBe(202)
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${(await res.json()).run_id}`)).status).toBe('completed')
  // "OK has a result" saved, then the run's status column deleted: OK is a plain column now.
  const stale = { column: 'OK', operator: 'has_result' }
  expect((await api.put(`/api/sheets/${sheetId}/filters`, { data: { where: [stale] } })).ok()).toBeTruthy()
  expect((await api.delete(`/api/sheets/${sheetId}/columns/Call`)).ok()).toBeTruthy()
  // A new one is still refused.
  const fresh = await api.put(`/api/sheets/${sheetId}/filters`, { data: { where: [stale,
    { column: 'Name', operator: 'has_error' }] } })
  expect(fresh.status()).toBe(400)
  expect((await fresh.json()).error).toContain(`"Name" isn't an AI, HTTP API or enrichment column`)

  // The panel: another rule applies; switching the kept rule off applies too.
  await open(page, tableId)
  await expect.poll(() => shownVals(page), { timeout: 15_000 }).toEqual(['v0', 'v1', 'v2'])
  await page.getByTestId('filter-button').click()
  await page.getByTestId('filter-panel').getByRole('button', { name: 'Add rule' }).first().click()
  const name = rules(page).nth(1)
  await name.getByLabel('Column').selectOption('Name')
  await name.getByLabel('Condition').selectOption('eq')
  await name.getByLabel('Value').fill('bob')
  await name.getByLabel('Value').press('Enter')
  await expect.poll(() => shownVals(page)).toEqual(['v1'])
  await expect(page.getByTestId('filter-panel')).not.toContainText('Not applied')
  await rules(page).nth(0).getByRole('switch').click()
  await expect.poll(() => whereOf(sheetId, 'Default'))
    .toEqual([{ column: 'Name', operator: 'eq', value: 'bob' }, { ...stale, enabled: false }])
  await rules(page).nth(0).getByRole('switch').click()
  await expect.poll(async () => (await whereOf(sheetId, 'Default'))?.length).toBe(2)
  await page.keyboard.press('Escape')

  // Reads and exports through the view: the rule reads OK's cells.
  const q = await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { view: 'Default' } })
  expect(q.status(), await q.text()).toBe(200)
  expect((await q.json()).rows.map((r: { data: { val: string } }) => r.data.val)).toEqual(['v1'])
  const csv = await v1.get(`/api/v1/sheets/${sheetId}/export?view=active`)
  expect(csv.status()).toBe(200)
  expect((await csv.text()).trim().split('\r\n')).toHaveLength(2)
})

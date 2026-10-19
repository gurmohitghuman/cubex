import { test, expect, Page, APIRequestContext } from '@playwright/test'
import { authedApi, BASE, importCsv } from './helpers'
import { mockTreg } from './helpers-treg'
import { expectBilledOnce, freshTreg, mockBilling, rowsOf, runIdsOf, seedLeadRows, startRun, verifiedEmailRun, waitRun }
  from './helpers-enrich'

// The answer panel and "add a field" (plan U7, Features D; Verification 8 and
// 24): a click on an enrichment cell shows who found it, what it cost, each
// step with its call id and the whole answer; "Add as column" fills a new column
// from the answers already stored, with no call to treg; a path into a part
// too big to keep is refused; later runs fill the new column too; and after a
// sort, a row delete and a CSV replace, each row's steps are still its own.

const COL = 'Work email'

async function colId(page: Page, name: string): Promise<string> {
  const header = page.locator('.ag-header-cell').filter({ hasText: name }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  return (await header.getAttribute('col-id'))!
}
async function clickCell(page: Page, row: number, column: string) {
  const id = await colId(page, column)
  await page.locator(`.ag-row[row-index="${row}"] .ag-cell[col-id="${id}"]`).first().click()
}
const answer = (api: APIRequestContext, sheetId: string, row: number, column = COL) =>
  api.get(`/api/enrich/sheets/${sheetId}/answer`, { params: { column, row } })
const calls = async () => (await mockTreg.requests()).filter(r => r.path.startsWith('/call/')).length

test('the answer panel, then a column added from stored answers: no calls, no cost', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api, { bigRawDomains: ['bigco.example'] })
  const { tableId, sheetId } = await seedLeadRows(api, [
    { Name: 'Ada Lovelace', Website: 'acme.example' }, { Name: 'Grace Hopper', Website: 'bigco.example' },
    { Name: 'Nobody Here', Website: 'quiet.example' },
  ])
  const runId = await startRun(api, sheetId, verifiedEmailRun())
  await waitRun(api, runId, ['completed'])
  expect((await rowsOf(api, sheetId)).map(r => r[COL])).toEqual(['✅ Valid', '✅ Valid', '⏭️ Not found'])

  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await clickCell(page, 0, COL)
  const panel = page.getByTestId('answer-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText(`Row 1 · ${COL}`)
  await expect(page.getByTestId('answer-summary')).toContainText('Found by')
  await expect(page.getByTestId('answer-cost')).toContainText('from your treg balance for this row')
  const steps = page.getByTestId('answer-step')
  await expect(steps).toHaveCount(2)
  await expect(steps.nth(0)).toContainText('Find:')
  await expect(steps.nth(0)).toContainText('ada.lovelace@acme.example')
  await expect(steps.nth(1)).toContainText('Check ada.lovelace@acme.example')
  await expect(steps.nth(0)).toContainText('call ')
  await expect(page.getByTestId('answer-rerun')).toBeVisible()
  await expect(panel).not.toContainText(String.fromCharCode(0x2014))

  // "Add as column" on a value: free, from the answers already kept.
  const before = await calls()
  const billed = (await mockBilling()).length
  const leaf = page.getByTestId('answer-tree').locator('[data-json-path="$.raw.data.first_name"]')
  await leaf.getByRole('button', { name: 'Column' }).click()
  await leaf.locator('input').fill('First name')
  await leaf.locator('input').press('Enter')
  await expect(page.getByTestId('answer-added')).toContainText('Adding First name')
  await expect.poll(async () => (await rowsOf(api, sheetId)).map(r => r['First name'] ?? ''), { timeout: 15_000 })
    .toEqual(['ada', 'grace', ''])
  expect(await calls()).toBe(before)
  expect((await mockBilling()).length).toBe(billed)
  // The new path now shows as a column in the panel's answer.
  await expect(page.getByTestId('answer-tree').locator('[data-json-path="$.raw.data.first_name"]'))
    .toContainText('First name')
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('.ag-header-cell').filter({ hasText: '📎 First name' }))
    .toHaveCount(1, { timeout: 15_000 })

  // Grace's long sources list was cut: the panel says so, and a path into the
  // dropped part can't become a column.
  await clickCell(page, 1, COL)
  await expect(page.getByTestId('answer-kept-notice')).toContainText('raw.sources from item')
  const refused = await api.post(`/api/enrich/sheets/${sheetId}/fields`,
    { data: { column: COL, jsonPath: '$.raw.sources[399].url', name: 'Source', row: 1 } })
  expect(refused.status()).toBe(400)
  expect((await refused.json()).error).toContain('was too big to keep')
  const clash = await api.post(`/api/enrich/sheets/${sheetId}/fields`,
    { data: { column: COL, jsonPath: '$.raw.data.last_name', name: 'first name', row: 0 } })
  expect(clash.status()).toBe(400)
  const again = await api.post(`/api/enrich/sheets/${sheetId}/fields`,
    { data: { column: COL, jsonPath: '$.raw.data.first_name', name: 'Given name', row: 0 } })
  expect((await again.json()).error).toBe('That value is already a column: First name.')
  const above = await api.post(`/api/enrich/sheets/${sheetId}/fields`,
    { data: { column: COL, jsonPath: '$.raw', name: 'Raw', row: 1 } })
  expect(above.status()).toBe(400)
  expect(await calls()).toBe(before)

  // Later runs fill it too: "Run all rows again" re-fills First name itself.
  const setup = await (await api.get(`/api/enrich/sheets/${sheetId}/column-setup`, { params: { column: COL } })).json()
  expect(setup.choices.outputs.some((o: any) => o.fromAnswer && o.columnName === 'First name')).toBe(true)
  const rerun = await api.post(`/api/enrich/sheets/${sheetId}/reruns`,
    { data: { column: COL, mode: 'all', status: 'any', estimateOnly: false } })
  expect(rerun.ok(), await rerun.text()).toBeTruthy()
  await waitRun(api, (await rerun.json()).runId, ['completed'])
  expect((await rowsOf(api, sheetId)).map(r => r['First name'] ?? '')).toEqual(['ada', 'grace', ''])
  await expectBilledOnce(runIdsOf(sheetId))
  await api.dispose()
})

test('after a sort, a row delete and a CSV replace, each row keeps its own steps', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const leads = ['Ann Alpha', 'Bea Beta', 'Cal Gamma', 'Dee Delta']
  const { sheetId } = await seedLeadRows(api, leads.map((Name, i) => ({ Name, Website: `co${i}.example` })))
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun()), ['completed'])

  // Every step names the row's own person (the finder builds first.last@).
  const expectOwnSteps = async () => {
    const page = await (await api.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)).json()
    for (const { rowIndex, data: row } of page.data.rows as Array<{ rowIndex: number; data: Record<string, string> }>) {
      const res = await answer(api, sheetId, rowIndex)
      expect(res.ok(), await res.text()).toBeTruthy()
      const view = await res.json()
      const first = row.Name.split(' ')[0].toLowerCase()
      expect(view.enrichment.calls.length).toBeGreaterThan(0)
      for (const c of view.enrichment.calls) expect(c.email).toContain(first)
      expect(view.result[0]).toEqual({ column: COL, value: row[COL] })
    }
  }
  await expectOwnSteps()
  const sorted = await api.post(`/api/sheets/${sheetId}/sort`, { data: { column: 'Name', direction: 'desc' } })
  expect(sorted.ok()).toBeTruthy()
  expect((await rowsOf(api, sheetId)).map(r => r.Name)).toEqual([...leads].reverse())
  await expectOwnSteps()

  const generation = (await (await api.get(`/api/sheets/${sheetId}?limit=1`)).json()).sheet.row_generation
  const del = await api.post(`/api/sheets/${sheetId}/rows/bulk-delete`,
    { data: { rowIndices: [1], rowGeneration: generation } })
  expect(del.ok(), await del.text()).toBeTruthy()
  await expectOwnSteps()

  // A replace brings new rows: their results went with the old ones, so the
  // panel has nothing for them rather than another row's steps.
  const csv = ['Name,Website', ...leads.map((n, i) => `${n},co${i}.example`)].join('\n')
  expect((await importCsv(api, sheetId, csv, { replaceData: true, filename: 'again.csv' })).ok()).toBeTruthy()
  const gone = await answer(api, sheetId, 0)
  expect(gone.status()).toBe(404)
  expect((await gone.json()).error).toContain('no stored answer')
  await api.dispose()
})

import { test, expect, APIRequestContext, Page, BrowserContext } from '@playwright/test'
import { authedApi, BASE, seedSheet } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'

// An HTTP API column's cell details show its stored reply as a JSON tree that
// stays small on screen whatever the reply holds: a 1.5 MB reply with 5,000
// items and a 300,000-character string opens a page at a time, hidden and
// right-to-left characters show as escapes, a click copies a value's JSONPath
// (or shows it to copy by hand where the browser can't), and "Add as column"
// on an item from the second page, and on a key jsonpath-plus used to misread
// (`@odata.nextLink`), fills a column from the stored replies.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
const ch = (...codes: number[]) => String.fromCharCode(...codes)
const RLO = ch(0x202e)
const BS = ch(92)

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'http answer tree'))
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose(); await api?.dispose() })

const reply = {
  results: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `Lead ${i}`, email: `lead${i}@acme.example` })),
  note: 'x'.repeat(300_000) + 'END',
  'a.b key': 'dotted',
  '@odata.nextLink': 'https://api.example/next?page=2',
  "user's name": 'Ada',
  [`${RLO}evil`]: `pay${RLO}lap`,
  meta: { page: 1, nested: { deeper: { deepest: true } } },
}

async function openTree(page: Page, context: BrowserContext): Promise<{ tableId: string; sheetId: string }> {
  const { tableId, sheetId } = await seedSheet(api, 1)
  rx.on('/big', { status: 200, body: JSON.stringify(reply) })
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { url: rx.url('/big'), response_mapping: [{ json_path: '$.results[0].name', column_name: 'First' }],
      master_column_name: 'Call' },
  })
  expect(res.status(), await res.text()).toBe(202)
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${(await res.json()).run_id}`)).status).toBe('completed')
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  const header = page.locator('.ag-header-cell').filter({ hasText: 'First' }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  const id = await header.getAttribute('col-id')
  await page.locator(`.ag-row[row-index="0"] .ag-cell[col-id="${id}"]`).first().click()
  await expect(page.getByTestId('answer-tree')).toBeVisible({ timeout: 15_000 })
  return { tableId, sheetId }
}

test('a big reply opens a page at a time, shows hidden characters, copies paths and adds a column', async ({
  page, context,
}) => {
  test.setTimeout(120_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const { sheetId } = await openTree(page, context)
  const tree = page.getByTestId('answer-tree')

  // What's on screen stays small: one page of the list, the start of the string.
  await expect(tree).toContainText('5,000 items')
  const results = tree.locator('[data-json-row="$.results"]')
  await expect(results.getByTestId('json-tree-pager').first()).toContainText('Items 0–99 of 5,000')
  await expect(results.getByTestId('json-tree-pager')).toHaveCount(2)
  const items = () => tree.locator('[data-json-row^="$.results["]')
    .evaluateAll(els => els.filter(e => /^\$\.results\[\d+\]$/.test(e.getAttribute('data-json-row')!)).length)
  expect(await items()).toBe(100)
  expect((await tree.innerText()).length).toBeLessThan(60_000)
  const note = tree.locator('[data-json-path="$.note"]')
  await expect(note.getByTestId('json-show-more')).toContainText('299,843 characters left')
  expect((await note.innerText()).length).toBeLessThan(400)
  await note.getByTestId('json-show-more').click()
  await expect(note.getByTestId('json-show-more')).toContainText('295,843 characters left')
  await note.getByRole('button', { name: 'show less' }).click()
  await expect(note.getByTestId('json-show-more')).toContainText('299,843 characters left')

  // A right-to-left override can't reorder anything: it shows as an escape.
  await expect(tree).toContainText(`"${BS}u202Eevil":`)
  await expect(tree).toContainText(`"pay${BS}u202Elap"`)
  expect(await tree.innerText()).not.toContain(RLO)

  // A value copies its path; so does a key, bracket-quoted when it needs it.
  await tree.locator('[data-json-path="$.results[3].email"]').getByTestId('json-value').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('$.results[3].email')
  await expect(page.getByText('Copied $.results[3].email')).toBeVisible()
  await tree.locator('[data-json-row=\'$["a.b key"]\']').getByTestId('json-key').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('$["a.b key"]')
  // In a CSS selector a backslash escapes, so the path's own backslash is doubled here.
  await tree.locator(`[data-json-row='$["${BS}${BS}u202Eevil"]']`).getByTestId('json-key').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`$["${BS}u202Eevil"]`)

  // The next page opens like the first; an item there becomes a column (free: no new request).
  await results.getByRole('button', { name: 'Next' }).first().click()
  await expect(results.getByTestId('json-tree-pager').first()).toContainText('Items 100–199 of 5,000')
  await expect(tree.locator('[data-json-row="$.results[0]"]')).toHaveCount(0)
  const leaf = tree.locator('[data-json-path="$.results[150].name"]')
  await leaf.getByRole('button', { name: 'Add as column' }).click()
  await leaf.getByLabel('Column name').fill('Lead 150')
  await leaf.getByLabel('Column name').press('Enter')
  await expect(page.getByTestId('answer-added')).toContainText('Adding Lead 150')
  await expect.poll(async () => {
    const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows
    return rows.map((r: any) => r.data['Lead 150'] ?? '')
  }, { timeout: 15_000 }).toEqual(['Lead 150'])
  expect(rx.hitsOn('/big')).toHaveLength(1)
  // The reload after the add keeps the page and what was opened.
  await expect(tree.locator('[data-json-path="$.results[150].name"]')).toContainText('✓ Lead 150')

  // A key jsonpath-plus read as path syntax fills its column with its own value.
  const odata = tree.locator('[data-json-path=\'$["@odata.nextLink"]\']')
  await odata.getByRole('button', { name: 'Add as column' }).click()
  await odata.getByLabel('Column name').fill('Next link')
  await odata.getByLabel('Column name').press('Enter')
  await expect.poll(async () => {
    const rows = (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows
    return rows.map((r: any) => r.data['Next link'] ?? '')
  }, { timeout: 15_000 }).toEqual(['https://api.example/next?page=2'])

  // A long list goes to any item.
  await results.getByLabel('Go to item').first().fill('4321')
  await results.getByLabel('Go to item').first().press('Enter')
  await expect(results.getByTestId('json-tree-pager').first()).toContainText('Items 4300–4399 of 5,000')
  await expect(tree.locator('[data-json-path="$.results[4321].email"]')).toContainText('lead4321@acme.example')
  await expect(tree.locator('[data-json-row="$.results[4321]"]')).toBeInViewport()
  expect(rx.hitsOn('/big')).toHaveLength(1)
})

test('where the browser has no clipboard, the path shows to copy by hand', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined }) })
  await openTree(page, context)
  const tree = page.getByTestId('answer-tree')
  await tree.locator('[data-json-path="$.meta.page"]').getByTestId('json-value').click()
  const manual = page.getByTestId('json-path-manual')
  await expect(manual).toBeVisible()
  await expect(manual.getByLabel('JSONPath')).toHaveValue('$.meta.page')
  await manual.getByRole('button', { name: 'Done' }).click()
  await expect(manual).toHaveCount(0)
  // Escape closes the box, not the drawer around it.
  await tree.locator('[data-json-path="$.meta.page"]').getByTestId('json-value').click()
  await manual.getByLabel('JSONPath').press('Escape')
  await expect(manual).toHaveCount(0)
  await expect(page.getByTestId('answer-panel')).toBeVisible()
})

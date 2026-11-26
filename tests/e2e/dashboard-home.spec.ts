import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, BASE, seedSheet } from './helpers'
import { bearer, httpConfig, makeToken } from './api-v1-run-helpers'
import { waitRunsSetUp } from './helpers-enrich'
import { Receiver } from './helpers-receiver'

// The home (pages/DashboardPage.tsx): the sidebar on the home, Settings and Trash, collapsed and remembered, never on a
// sheet and always collapsed on a phone; "Tables" with a search by name; the list sorted by a header's click and kept
// so; a table's sheet count; the Runs column, live, linking to the sheet with the runs; and Import CSV from the New
// table button, which makes a table named after the file and opens it with the file's rows.
const rx = new Receiver()
let api: APIRequestContext
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { await rx.start(); api = await authedApi() })
test.afterAll(async () => { await rx.stop() })

const signIn = async (page: Page) => page.context().addCookies((await api.storageState()).cookies)
const sidebar = (page: Page) => page.getByTestId('app-sidebar')
// A table of its own beside the others (seedSheet empties the workspace first).
const table = async (name: string): Promise<string> => {
  const made = await api.post('/api/tables', { data: { name } })
  expect(made.ok(), await made.text()).toBeTruthy()
  return (await made.json()).id
}
const named = async (name: string) => {
  const { tableId, sheetId } = await seedSheet(api, 2)
  expect((await api.put(`/api/tables/${tableId}`, { data: { name } })).ok()).toBeTruthy()
  return { tableId, sheetId }
}

test('the sidebar: on the home, Settings and Trash, collapsed and remembered; not on a sheet', async ({ page }) => {
  await signIn(page)
  const { tableId } = await named(`Sidebar ${Date.now()}`)
  await page.goto(`${BASE}/`)
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false', { timeout: 15_000 })
  await expect(page.getByTestId('nav-tables')).toHaveAttribute('aria-current', 'page')

  await sidebar(page).getByRole('link', { name: 'Agent access' }).click()
  await expect(page).toHaveURL(/\/settings\/agents$/)
  await expect(sidebar(page).getByRole('link', { name: 'Agent access' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('open-settings')).not.toHaveAttribute('aria-current', 'page')
  await page.getByTestId('open-trash').click()
  await expect(page).toHaveURL(/\/trash$/)
  await expect(page.getByTestId('open-trash')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('open-docs'))
    .toHaveAttribute('href', /^https:\/\/github\.com\/gurmohitghuman\/cubex\/tree\//)

  await page.getByTestId('sidebar-toggle').click()
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
  await page.reload()
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true', { timeout: 15_000 })
  await page.getByTestId('sidebar-toggle').click()
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await expect(sidebar(page)).toHaveCount(0)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('the sidebar is collapsed to its icons, with no way to open it wide', async ({ page }) => {
    await signIn(page)
    await page.goto(`${BASE}/`)
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true', { timeout: 15_000 })
    await expect(page.getByTestId('sidebar-toggle')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New Table' })).toBeVisible()
  })
})

test('search by name, sort by a header (kept on reload), and a table\'s sheet count', async ({ page }) => {
  await signIn(page)
  const stamp = String(Date.now())
  const alpha = await table(`Alpha ${stamp}`)
  await table(`Beta ${stamp}`)
  const added = await api.post(`/api/tables/${alpha}/sheets`, { data: { name: 'Two' } })
  expect(added.ok(), await added.text()).toBeTruthy()
  const names = page.getByTestId('table-name')
  await page.goto(`${BASE}/`)
  const search = page.getByTestId('tables-search')
  await search.fill(stamp)
  // Newest updated first until a header is clicked: these two may share a second, so only how many.
  await expect(names).toHaveCount(2, { timeout: 15_000 })
  await expect(page.locator(`[data-testid=table-row][data-table-id="${alpha}"]`)
    .getByTestId('table-sheet-count')).toHaveText('2 sheets')

  await page.getByTestId('sort-name').click()
  await expect(page.getByTestId('sort-name')).toHaveAttribute('data-sort', 'asc')
  await expect(names).toHaveText([`Alpha ${stamp}`, `Beta ${stamp}`])
  await page.getByTestId('sort-name').click()
  await expect(names).toHaveText([`Beta ${stamp}`, `Alpha ${stamp}`])
  await page.reload()
  await page.getByTestId('tables-search').fill(stamp)
  await expect(page.getByTestId('sort-name')).toHaveAttribute('data-sort', 'desc', { timeout: 15_000 })
  await expect(names).toHaveText([`Beta ${stamp}`, `Alpha ${stamp}`])

  await page.getByTestId('tables-search').fill(`Alpha ${stamp}`)
  await expect(names).toHaveText([`Alpha ${stamp}`])
  await page.getByTestId('tables-search').fill(`no such table ${stamp}`)
  await expect(page.getByTestId('tables-no-match')).toContainText(`no such table ${stamp}`)
  await page.getByRole('button', { name: 'Clear the search' }).click()
  await expect(page.getByTestId('tables-search')).toHaveValue('')
  await expect(page.getByTestId('tables-list')).toBeVisible()
})

test('Runs: a run started, paused and stopped elsewhere shows as it goes, and links to its sheet', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await signIn(page)
  const { tableId, sheetId } = await named(`Runs ${Date.now()}`)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e home runs'))
  const runs = page.locator(`[data-testid=table-runs][data-table-id="${tableId}"]`)
  await page.goto(`${BASE}/`)
  await expect(page.locator(`[data-testid=table-row][data-table-id="${tableId}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(runs).toHaveCount(0)

  // The receiver keeps every answer back, so the run goes on until it is stopped.
  const release = rx.hold()
  try {
    const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
      data: { config: httpConfig(rx.url('/home-runs/{{val}}'), 'Slow') },
    })
    expect(start.status(), await start.text()).toBe(202)
    const runId = (await start.json()).run_id as string
    await expect(runs).toHaveText('1 running', { timeout: 10_000 })
    await waitRunsSetUp(sheetId)
    expect((await v1.post(`/api/v1/http-runs/${runId}/pause`)).status()).toBe(200)
    await expect(runs).toHaveText('1 paused', { timeout: 10_000 })

    await runs.click()
    await expect(page).toHaveURL(new RegExp(`/table/${tableId}/${sheetId}$`))
    await page.goBack()
    await expect(runs).toHaveText('1 paused', { timeout: 15_000 })
    expect((await v1.post(`/api/v1/http-runs/${runId}/cancel`)).status()).toBe(200)
    await expect(runs).toHaveCount(0, { timeout: 10_000 })
  } finally {
    release()
    await v1.dispose()
  }
})

test('Import CSV from the New table button: a table named after the file, opened with its rows', async ({ page }) => {
  await signIn(page)
  const name = `people ${Date.now()}`
  await page.goto(`${BASE}/`)
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('new-table-menu').click()
  await page.getByTestId('new-table-import').click()
  await (await chooser).setFiles({
    name: `${name}.csv`, mimeType: 'text/csv',
    buffer: Buffer.from('Name,Email\nAda,ada@x.example\nLin,lin@x.example\n'),
  })
  await expect(page).toHaveURL(/\/table\/[^/]+\/[^/]+$/, { timeout: 15_000 })
  await expect(page.locator('.ag-row[row-index="1"] [col-id^="col_"]').first()).toHaveText('Lin', { timeout: 15_000 })
  await expect(page.getByText('2 rows imported into')).toBeVisible()
  // The list's count is made again after the import; it reads 2 once made.
  await expect.poll(async () => ((await (await api.get('/api/tables')).json()) as Array<{ name: string;
    row_count: number }>).find(t => t.name === name)?.row_count, { timeout: 15_000 }).toBe(2)
})

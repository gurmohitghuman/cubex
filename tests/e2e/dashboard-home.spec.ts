// Over 200 lines: the home's cases, each a person's way through it (sidebar, list, runs, import, star and tabs).
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { authedApi, BASE, seedSheet } from './helpers'
import { bearer, httpConfig, makeToken } from './api-v1-run-helpers'
import { waitRunsSetUp } from './helpers-enrich'
import { Receiver } from './helpers-receiver'

// The home (pages/DashboardPage.tsx): the sidebar on the home, Settings and Trash, collapsed and remembered, never on a
// sheet and always collapsed on a phone; "Tables" with a search by name; the list sorted by a header's click and kept
// so; a table's sheet count; the star and the All, Recent and Favorites tabs (kept on reload; Recent the last opened
// first, with a sort of its own); the Runs column, live, linking to the sheet with the runs; and Import CSV from the
// New table button, which makes a table named after the file and opens it with the file's rows.
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
  test('the sidebar is collapsed to its icons, with no way to open it wide; a table\'s row fits: its name, star '
    + 'and ⋯ menu on screen', async ({ page }) => {
    await signIn(page)
    const { tableId } = await named(`Phone ${Date.now()}`)
    await page.goto(`${BASE}/`)
    await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true', { timeout: 15_000 })
    await expect(page.getByTestId('sidebar-toggle')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New Table' })).toBeVisible()
    const row = page.locator(`[data-testid=table-row][data-table-id="${tableId}"]`)
    await expect(row.getByRole('button', { name: 'Table actions' })).toBeInViewport({ ratio: 1 })
    await expect(row.getByTestId('table-star')).toBeInViewport({ ratio: 1 })
    expect((await row.getByTestId('table-name').boundingBox())!.width).toBeGreaterThan(60)
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

test('the star and the tabs: Favorites lists the starred tables, Recent the opened ones, the last first; the tab '
  + 'is kept on reload', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page)
  const stamp = String(Date.now())
  const { tableId: first } = await named(`First ${stamp}`)
  const second = await table(`Second ${stamp}`)
  const row = (id: string) => page.locator(`[data-testid=table-row][data-table-id="${id}"]`)
  const names = page.getByTestId('table-name')
  const tab = (id: string) => page.getByTestId(`tables-tab-${id}`)
  await page.goto(`${BASE}/`)
  await expect(row(second)).toBeVisible({ timeout: 15_000 })
  await expect(tab('all')).toHaveAttribute('aria-selected', 'true')

  // A tab with nothing in it says what goes there.
  await tab('favorites').click()
  await expect(page.getByTestId('tables-tab-empty')).toContainText('No favorites yet')
  await tab('recent').click()
  await expect(page.getByTestId('tables-tab-empty')).toContainText('The tables you open show here')

  // Starred from All: shown at once, kept by the server, the table not opened; then under Favorites.
  await tab('all').click()
  const star = row(second).getByTestId('table-star')
  await expect(star).toHaveAttribute('aria-pressed', 'false')
  const saved = page.waitForResponse(r => r.url().endsWith(`/api/tables/${second}/starred`))
  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  expect((await saved).ok()).toBeTruthy()
  await expect(page).toHaveURL(`${BASE}/`)
  await tab('favorites').click()
  await expect(names).toHaveText([`Second ${stamp}`])
  await page.reload()
  await expect(tab('favorites')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
  await expect(names).toHaveText([`Second ${stamp}`])
  // Its star taken off there, it leaves Favorites.
  await row(second).getByTestId('table-star').click()
  await expect(page.getByTestId('tables-tab-empty')).toContainText('No favorites yet')
  // A table made from Favorites shows under All: it is neither starred nor opened.
  await page.getByTestId('new-table').click()
  await page.getByPlaceholder('Enter table name').fill(`Third ${stamp}`)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(tab('all')).toHaveAttribute('aria-selected', 'true')
  await expect(names.filter({ hasText: `Third ${stamp}` })).toBeVisible()

  // Opened from the home, one then the other: Recent lists the last opened first, with when.
  for (const id of [first, second]) {
    await page.goto(`${BASE}/`)
    await tab('all').click()
    const opened = page.waitForResponse(r => r.url().endsWith(`/api/tables/${id}/opened`))
    await row(id).click()
    await expect(page).toHaveURL(new RegExp(`/table/${id}`))
    expect((await opened).status()).toBe(204)
  }
  // The 204 says the open was noted; it is written once the write lock is free. The list is read once a page loads,
  // so wait for both to be written first.
  await expect.poll(async () => {
    const list = await (await api.get('/api/tables')).json() as Array<{ id: string; last_opened_at: string | null }>
    const at = (id: string) => list.find(t => t.id === id)?.last_opened_at ?? ''
    return at(first) !== '' && at(second) > at(first)
  }, { timeout: 15_000 }).toBe(true)
  await page.goto(`${BASE}/`)
  await tab('recent').click()
  await expect(names).toHaveText([`Second ${stamp}`, `First ${stamp}`], { timeout: 15_000 })
  await expect(page.getByTestId('sort-opened')).toHaveAttribute('data-sort', 'desc')
  await expect(row(second).getByTestId('table-opened')).not.toBeEmpty()
  // Recent's own sort: by name there leaves All's as it was.
  await page.getByTestId('sort-name').click()
  await expect(names).toHaveText([`First ${stamp}`, `Second ${stamp}`])
  // Again turns it round; a third time goes back to Recent's own order, whose header a narrow screen doesn't show.
  await page.getByTestId('sort-name').click()
  await expect(page.getByTestId('sort-name')).toHaveAttribute('data-sort', 'desc')
  await page.getByTestId('sort-name').click()
  await expect(page.getByTestId('sort-opened')).toHaveAttribute('data-sort', 'desc')
  await expect(names).toHaveText([`Second ${stamp}`, `First ${stamp}`])
  await tab('all').click()
  await expect(page.getByTestId('sort-updated')).toHaveAttribute('data-sort', 'desc')
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

test('Import CSV from the New table button: a table named after the file (a taken name gets "(2)"), opened',
  async ({ page }) => {
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

  // The same file again: its name is taken, so the table is "<name> (2)", not an error.
  await page.goto(`${BASE}/`)
  const again = page.waitForEvent('filechooser')
  await page.getByTestId('new-table-menu').click()
  await page.getByTestId('new-table-import').click()
  await (await again).setFiles({
    name: `${name}.csv`, mimeType: 'text/csv', buffer: Buffer.from('Name\nKai\n'),
  })
  await expect(page).toHaveURL(/\/table\/[^/]+\/[^/]+$/, { timeout: 15_000 })
  await expect(page.getByText(`1 row imported into "${name} (2)".`)).toBeVisible({ timeout: 15_000 })
})

// A hidden home (its tab behind another) lets its held Runs wait go at once, so background tabs don't hold the
// browser's few connections to the server, and asks again, without a key, the moment it is shown.
test('a hidden home lets its Runs wait go, and asks again at once when shown', async ({ page }) => {
  await signIn(page)
  const asks: string[] = []
  const dropped: string[] = []
  page.on('request', r => { if (r.url().includes('/api/tables/runs')) asks.push(r.url()) })
  page.on('requestfailed', r => { if (r.url().includes('/api/tables/runs')) dropped.push(r.url()) })
  const show = (hidden: boolean) => page.evaluate(h => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
  await page.goto(`${BASE}/`)
  // The first ask answers at once; the next carries its key and is held.
  await expect.poll(() => asks.filter(u => u.includes('since=')).length, { timeout: 10_000 }).toBeGreaterThan(0)
  await show(true)
  await expect.poll(() => dropped.length, { timeout: 5_000 }).toBeGreaterThan(0)
  const whileHidden = asks.length
  await page.waitForTimeout(1_500)
  expect(asks.length, 'nothing asked while hidden').toBe(whileHidden)
  await show(false)
  await expect.poll(() => asks.length, { timeout: 5_000 }).toBeGreaterThan(whileHidden)
  expect(asks[whileHidden], 'shown: asked without a key, so it answers at once').not.toContain('since=')
})

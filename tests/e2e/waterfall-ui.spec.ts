import { test, expect, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { callEveryRow, freshTreg, rowsOf, seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'

// The Waterfall drawer in the browser: the toolbar button, the result types,
// inputs matched to the columns by name, a treg step found by search and an
// HTTP step, the estimate (average and most a row), a run on every row with its
// progress, the result and "answered by" cells, a cell's trace, and the column
// menu's Edit Waterfall opening the same steps again.
const rx = new Receiver()
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/shots/${name}.png`, fullPage: true })
const drawer = (page: Page) => page.getByTestId('waterfall-drawer')

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => {
  await rx.start()
  rx.on('/ui-find', { status: 200, body: JSON.stringify({ email: 'nobody.here@nobody.example' }) })
})
test.afterAll(async () => { await rx.stop() })

test('build a waterfall, estimate it, run it, read a trace, edit it again', async ({ page, context }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedCsv(api, ['Name,Website', 'Maya Chen,https://stripe.com',
    'Nobody Here,nobody.example'].join('\n'))
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })

  await page.getByRole('button', { name: 'Waterfall', exact: true }).click()
  await expect(drawer(page).getByTestId('waterfall-result-types')).toBeVisible()
  await drawer(page).getByRole('button', { name: /Work email/ }).click()
  await expect(drawer(page).getByLabel('Full name', { exact: true })).toHaveValue('c:Name')
  await expect(drawer(page).getByLabel('Company domain', { exact: true })).toHaveValue('c:Website')

  // A treg step found by search, then an HTTP step on the local receiver.
  await drawer(page).getByRole('button', { name: 'Enrichment tool' }).click()
  await drawer(page).getByLabel('Search tools').fill('work email')
  await drawer(page).getByTestId('waterfall-tool-search')
    .getByRole('button', { name: /work email address.*providers in turn/ }).first().click()
  await expect(drawer(page).getByTestId('waterfall-tool')).toBeVisible()
  await drawer(page).getByRole('button', { name: 'HTTP API' }).click()
  await drawer(page).getByLabel('URL', { exact: true }).fill(rx.url('/ui-find?d={{domain}}', 'ui'))
  await drawer(page).getByLabel('Value path', { exact: true }).fill('$.email')
  await drawer(page).getByLabel('Step label').last().fill('Own API')
  await expect(drawer(page).getByTestId('waterfall-step')).toHaveCount(2)

  const estimate = drawer(page).getByTestId('waterfall-estimate')
  await expect(estimate).toContainText('a row on average', { timeout: 15_000 })
  await expect(estimate).toContainText('2 rows')
  await shot(page, 'waterfall-drawer-setup')

  // A dry run first: both rows, nothing written; the real run then replays it.
  await drawer(page).getByRole('button', { name: 'Try on 3 rows' }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  const dry = drawer(page).getByTestId('waterfall-dry-run')
  await expect(dry).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
  await expect(dry.getByTestId('waterfall-dry-row')).toHaveCount(2)
  await expect(dry.getByTestId('waterfall-dry-row').nth(1)).toHaveAttribute('data-answered', 'Own API')
  await shot(page, 'waterfall-dry-run')
  expect((await rowsOf(api, sheetId))[0]['Work email']).toBeUndefined()
  await drawer(page).getByRole('button', { name: 'Back to the setup' }).click()
  await expect(drawer(page).getByTestId('waterfall-step')).toHaveCount(2)

  await drawer(page).getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  await expect(drawer(page).getByTestId('waterfall-run'))
    .toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
  await expect(drawer(page).getByTestId('waterfall-run-step')).toHaveCount(2)
  await shot(page, 'waterfall-drawer-run')
  await drawer(page).getByRole('button', { name: 'Done' }).click()
  await page.keyboard.press('Escape')

  await expect.poll(async () => (await rowsOf(api, sheetId))[1]['Work email']).toBe('nobody.here@nobody.example')
  const rows = await rowsOf(api, sheetId)
  expect(rows[0]['Work email']).toBe('maya.chen@stripe.com')
  expect(rows[1]['Work email (Answered by)']).toBe('Own API')

  // A click on a result cell opens its trace: the treg step found nothing, the API answered.
  await page.reload()
  await expect(page.locator('.ag-row[row-index="1"]').first()).toBeVisible({ timeout: 15_000 })
  await page.locator('.ag-row[row-index="1"] .ag-cell').filter({ hasText: 'nobody.here@nobody.example' }).first()
    .click()
  const trace = page.getByTestId('waterfall-trace')
  await expect(trace).toBeVisible()
  await expect(trace.getByTestId('waterfall-trace-step')).toHaveCount(2)
  await expect(trace.getByTestId('waterfall-trace-step').nth(1)).toHaveAttribute('data-outcome', 'answered')
  await shot(page, 'waterfall-trace')
  await page.keyboard.press('Escape')

  // The column menu: Waterfall Actions, and Edit opens the same steps.
  await page.locator('.ag-header-cell').filter({ hasText: 'Work email' }).first().locator('.ag-header-cell-text')
    .first().click()
  await expect(page.getByText('Waterfall Actions')).toBeVisible()
  await shot(page, 'waterfall-menu')
  await page.getByText('Edit Waterfall').click()
  await expect(drawer(page).getByTestId('waterfall-step')).toHaveCount(2)
  await expect(drawer(page).getByTestId('waterfall-step').nth(1)).toContainText('Own API')
  // Its tool by name, and every row already run: nothing to run is said plainly, not as a failure.
  await expect(drawer(page).getByTestId('waterfall-step').first()).not.toContainText('treg.people.email.find')
  await expect(drawer(page).getByTestId('waterfall-estimate')).toContainText('run already', { timeout: 10_000 })
  await expect(drawer(page).getByTestId('waterfall-estimate').locator('.text-red-700')).toHaveCount(0)
  await shot(page, 'waterfall-edit')
})

test('a formula step with an email check, tested alone from its card', async ({ page, context }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const api = await authedApi()
  await freshTreg(api)
  const { tableId } = await seedCsv(api, ['Name,Website', 'Ada Byron,analytical.example',
    'Risky Person,risky.example'].join('\n'))
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Waterfall', exact: true }).click()
  await drawer(page).getByRole('button', { name: /Work email/ }).click()
  await drawer(page).getByRole('button', { name: 'Formula' }).click()
  await drawer(page).getByLabel('Step formula').fill("{{full_name}}.toLowerCase().replace(' ', '.') + '@' + {{domain}}")
  await drawer(page).getByLabel('Check', { exact: true }).selectOption('verify')
  await expect(drawer(page).getByLabel('Accept')).toHaveValue('safest')
  await expect(drawer(page).getByTestId('waterfall-estimate')).toContainText('a row on average', { timeout: 15_000 })
  await shot(page, 'waterfall-formula-check')

  await drawer(page).getByRole('button', { name: 'Test this step' }).click()
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  const dry = drawer(page).getByTestId('waterfall-dry-run')
  await expect(dry).toHaveAttribute('data-status', 'completed', { timeout: 30_000 })
  await expect(dry.getByTestId('waterfall-dry-step').nth(0)).toHaveAttribute('data-outcome', 'answered')
  await expect(dry.getByTestId('waterfall-dry-step').nth(1)).toHaveAttribute('data-outcome', 'rejected')
  await expect(dry).toContainText('check failed (risky)')
  await shot(page, 'waterfall-test-step')
  await api.dispose()
})

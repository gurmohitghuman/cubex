import { test, expect, Page, APIRequestContext } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { mockTreg } from './helpers-treg'
import {
  expectBilledOnce, expectSettledBilledOnce, freshTreg, rowsOf, runStatus, seedLeadRows, startRun, waitRun,
} from './helpers-enrich'

// A run that pauses itself says why in the drawer, with the fix in place
// (plan U5, Verification 4, 5, 14, 15): raise the run's limit and resume, raise
// today's limit and resume, top up at treg then resume, wait for treg. With the
// drawer closed, the pause toasts with Show, which opens the run.

const LEADS = Array.from({ length: 6 }, (_, i) => ({ Name: `Lead Person${i}`, Website: `co${i}.example` }))
const drawer = (page: Page) => page.getByTestId('enrich-drawer')
const notice = (page: Page) => page.getByTestId('enrich-paused')

const findRun = (over: Record<string, unknown> = {}) => ({
  toolId: 'treg.people.email.find', preset: null, columnName: 'Find email', continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
  rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
  ...over,
})

async function openSheet(page: Page, context: any, api: APIRequestContext, tableId: string) {
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
}

const openMenu = async (page: Page, column: string) => {
  await page.locator('.ag-header-cell').filter({ hasText: column }).first()
    .locator('.ag-header-cell-text').first().click()
}

// The column menu's View Run opens the drawer on the column's active run.
async function viewRun(page: Page, column: string) {
  await openMenu(page, column)
  await page.getByRole('menuitem', { name: /View Run/ }).click()
  await expect(page.getByTestId('enrich-run-step')).toBeVisible({ timeout: 10_000 })
}

test('run limit: the notice raises it in place and the run finishes', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  const runId = await startRun(api, sheetId, findRun({ maxCostPerRowUsd: 0.01, spendLimitUsd: 0.02 }))
  expect((await waitRun(api, runId, ['paused'])).pauseReason).toBe('spend_limit')
  await openSheet(page, context, api, tableId)
  await viewRun(page, 'Find email')
  await expect(notice(page)).toContainText('Paused. The run reached its $0.02 limit')
  // Below one more row's cap, it says how much it needs and won't resume.
  await notice(page).getByLabel('Raise the run limit to').fill('0.021')
  await expect(notice(page)).toContainText('so it needs at least')
  await expect(page.getByTestId('enrich-raise-resume')).toBeDisabled()
  await notice(page).getByLabel('Raise the run limit to').fill('1')
  await page.getByTestId('enrich-raise-resume').click()
  await expect(page.getByTestId('enrich-view-results')).toBeVisible({ timeout: 30_000 })
  const done = await runStatus(api, runId)
  expect(done.status).toBe('completed')
  expect(done.spendLimitUsd).toBe(1)
  await expectBilledOnce([runId])
  await api.dispose()
})

test("today's limit: the notice raises it in place", async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  try {
    // A first run spends a little today, then today's limit sits below one row's cap.
    await waitRun(api, await startRun(api, sheetId, findRun({ rows: { mode: 'all', test: true } })), ['completed'])
    expect((await api.put('/api/settings/enrich-daily-limit', { data: { limitUsd: 0.01 } })).ok()).toBeTruthy()
    const runId = await startRun(api, sheetId, findRun({ continueColumn: true }))
    expect((await waitRun(api, runId, ['paused'])).pauseReason).toBe('daily_limit')
    await openSheet(page, context, api, tableId)
    await viewRun(page, 'Find email')
    await expect(notice(page)).toContainText("Today's $0.01 enrichment limit is reached. It resets at midnight UTC (")
    await expect(notice(page)).toContainText('Or resume it after the reset.')
    await expect(notice(page)).toContainText('It stays at the new amount every day')
    await notice(page).getByLabel('Raise the daily limit to').fill('5')
    await page.getByTestId('enrich-raise-resume').click()
    await expect(page.getByTestId('enrich-view-results')).toBeVisible({ timeout: 30_000 })
    expect((await (await api.get('/api/settings')).json()).enrichDailyLimit.limitUsd).toBe(5)
  } finally {
    await api.put('/api/settings/enrich-daily-limit', { data: { limitUsd: 10 } })
    await api.dispose()
  }
})

test('the balance: a toast with Show, then top up and resume in the drawer', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  await waitRun(api, await startRun(api, sheetId, findRun({ rows: { mode: 'all', test: true } })), ['completed'])
  await openSheet(page, context, api, tableId)
  // A Set up in progress, which watching a run must not overwrite.
  await page.getByRole('button', { name: 'Enrichment', exact: true }).click()
  await drawer(page).getByTestId('enrich-tool-card').filter({ hasText: 'Verified work email' }).click()
  await expect(page.getByText('Set up Verified work email')).toBeVisible()
  await page.keyboard.press('Escape')
  await mockTreg.set({ scenario: { kind: 'insufficient', count: 100 } })
  // Retry the rest from the column menu with the drawer closed.
  await openMenu(page, 'Find email')
  await page.getByRole('menuitem', { name: /Run Rows Not Enriched/ }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Run rows not enriched' })
  await expect(dialog).toContainText('1 row not enriched yet')
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  const toast = page.getByTestId('enrich-pause-toast')
  await expect(toast).toContainText('Paused: Your treg balance ran out', { timeout: 20_000 })
  await toast.getByRole('button', { name: 'Show' }).click()
  await expect(notice(page)).toContainText('Your treg balance ran out')
  await expect(notice(page).getByRole('link', { name: /Top up at treg/ }))
    .toHaveAttribute('href', 'https://treg.to/app#billing')
  await mockTreg.set({ scenario: null })
  await page.getByTestId('enrich-resume').click()
  await expect(page.getByTestId('enrich-view-results')).toBeVisible({ timeout: 30_000 })
  expect((await rowsOf(api, sheetId)).every(r => r['Find email'] === '✅ Found')).toBeTruthy()
  // Back from the watched run: the Set up is still there.
  await drawer(page).getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByText('Set up Verified work email')).toBeVisible()
  await api.dispose()
})

test('header controls pause, resume and cancel the run the drawer shows', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api, { delayMs: 1200 })
  const { tableId, sheetId } = await seedLeadRows(api, LEADS)
  const runId = await startRun(api, sheetId, findRun())
  await openSheet(page, context, api, tableId)
  await viewRun(page, 'Find email')
  await expect(page.getByTestId('enrich-header-pause')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('enrich-header-pause').click()
  await expect(page.getByTestId('enrich-header-resume')).toBeVisible({ timeout: 10_000 })
  // A pause the user clicked needs no notice: the header's Resume is the fix.
  await expect(notice(page)).toHaveCount(0)
  await page.getByTestId('enrich-header-resume').click()
  await expect(page.getByTestId('enrich-header-pause')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('enrich-header-cancel').click()
  await expect(page.getByTestId('enrich-run-headline')).toContainText('The run was stopped', { timeout: 15_000 })
  expect((await runStatus(api, runId)).status).toBe('cancelled')
  await expect(drawer(page)).toBeVisible()
  // Calls in flight at the cancel still finish and reach the ledger: what treg
  // billed and what Cubex recorded meet (and nothing leaks into the next spec).
  await expectSettledBilledOnce([runId])
  await api.dispose()
})

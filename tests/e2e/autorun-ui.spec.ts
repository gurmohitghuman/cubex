import { test, expect, Page } from '@playwright/test'
import { authedApi, BASE } from './helpers'
import { mockTreg } from './helpers-treg'
import { freshTreg, startRun, verifiedEmailRun, waitRun } from './helpers-enrich'
import { autorunOf, seedViaWebhook } from './helpers-autorun'
import { openDataMenu } from './helpers-ui'

// Auto-run in the grid (plan U6, U10; Verification 33): the column menu turns
// it on through its dialog (with the webhook warning), the header shows ⚡ and
// its tooltip, the sheet header's chip pauses every auto-run, the CSV import
// says what new rows set off; and a second tab, which started nothing, sees
// auto-run cells paint live (it streams runs the change poll names).

const COL = 'Work email'

async function colId(page: Page, name: string): Promise<string> {
  const header = page.locator('.ag-header-cell').filter({ hasText: name }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  return (await header.getAttribute('col-id'))!
}
// The cell of `column` in the (center) row showing `name`.
const cellOf = async (page: Page, name: string, column: string) =>
  page.locator('.ag-center-cols-container .ag-row', { hasText: name })
    .locator(`.ag-cell[col-id="${await colId(page, column)}"]`).first()

test('turn on auto-run from the column menu; ⚡, tooltip, chip and the import notice', async ({ page, context }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 2200, height: 900 })
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun()), ['completed'])

  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.locator('.ag-header-cell').filter({ hasText: COL }).first().locator('.ag-header-cell-text').first().click()
  await page.getByRole('menuitem', { name: '⚡ Turn On Auto-run' }).click()
  const dialog = page.getByTestId('autorun-dialog')
  await expect(dialog).toContainText(`Run "${COL}" automatically`)
  await expect(page.getByTestId('autorun-webhook')).toContainText("Anyone with this sheet's webhook URL can add rows")
  await dialog.getByLabel('Daily cap').fill('2')
  await dialog.getByRole('button', { name: 'Turn on' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await autorunOf(api, sheetId, COL))?.dailyCapUsd).toBe(2)

  await expect(page.getByTestId('autorun-icon')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('header-tip-anchor').first().hover()
  await expect(page.getByTestId('header-tip')).toContainText('Auto-run on, $0.00 of $2.00 used today')
  await expect(page.getByTestId('autorun-chip')).toHaveText('Auto-run on')

  await page.getByTestId('autorun-chip').click()
  await page.getByRole('button', { name: 'Pause all auto-runs' }).click()
  await expect(page.getByTestId('autorun-chip')).toHaveText('Auto-run paused', { timeout: 15_000 })
  expect((await autorunOf(api, sheetId, COL)).pausedReason).toBe('user')
  await page.getByTestId('autorun-chip').click()
  await page.getByRole('button', { name: 'Resume all auto-runs' }).click()
  await expect(page.getByTestId('autorun-chip')).toHaveText('Auto-run on', { timeout: 15_000 })

  // The CSV import says what new rows set off, with the pause toggle.
  await openDataMenu(page, 'Import CSV')
  await page.locator('input[type="file"]').setInputFiles({
    name: 'more.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Name,Website\nAda Lovelace,figma.com\nGrace Hopper,notion.so\n'),
  })
  const notice = page.getByTestId('import-autorun-notice')
  await expect(notice).toContainText(`${COL} runs on new rows automatically. These 2 rows could cost about`)
  await expect(notice).toContainText('Pause auto-run for this import')
  await expect(page.locator('body')).not.toContainText(String.fromCharCode(0x2014))
  await api.dispose()
})

test('a second tab sees auto-run cells paint without a reload', async ({ browser }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { tableId, sheetId, deliver } = await seedViaWebhook(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  await waitRun(api, await startRun(api, sheetId, verifiedEmailRun()), ['completed'])
  expect((await api.put(`/api/autorun/sheets/${sheetId}/columns`, {
    data: { column: COL, enabled: true, dailyCapUsd: 1 },
  })).ok()).toBeTruthy()

  const ctx = await browser.newContext({ viewport: { width: 2200, height: 900 } })
  await ctx.addCookies((await api.storageState()).cookies)
  const tab = await ctx.newPage()
  await tab.goto(`${BASE}/table/${tableId}`)
  await expect(tab.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  let navigations = 0
  tab.on('framenavigated', f => { if (f === tab.mainFrame()) navigations++ })
  const streams: string[] = []
  tab.on('request', r => { if (/\/api\/http\/jobs\/[^/]+\/stream/.test(r.url())) streams.push(r.url()) })

  // Slow answers: the row is still running when the tab learns of the run.
  await mockTreg.set({ delayMs: 1500 })
  await deliver({ Name: 'Ada Lovelace', Website: 'figma.com' })
  await expect(await cellOf(tab, 'Ada Lovelace', COL)).toContainText('✅', { timeout: 30_000 })
  await mockTreg.set({ delayMs: 0 })
  expect(streams.length).toBeGreaterThan(0)
  expect(navigations).toBe(0)
  await ctx.close(); await api.dispose()
})

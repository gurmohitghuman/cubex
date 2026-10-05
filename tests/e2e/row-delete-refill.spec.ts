import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE } from './helpers'

// Regression: bulk-deleting all-but-one of the loaded row window (select-all in
// view → unselect one row → delete) left ONLY the kept row visible until a
// manual page refresh. The survivors beyond the window never loaded because a
// near-empty grid has no scrollbar (scroll-driven loadMore can't fire) and the
// old useRowWindowRefill only refilled a fully-EMPTY window. Fixed: the hook
// now refills any UNDERFILLED window (rows < INITIAL_ROW_LOAD && rows <
// totalRows) via a silent reload, so the survivors appear in place.
const DATA_CELL = (row: number) => `.ag-row[row-index="${row}"] [col-id^="col_"]`
const SEL_CHECKBOX = (row: number) =>
  `.ag-row[row-index="${row}"] [col-id="ag-Grid-SelectionColumn"] input`
const SELECT_ALL = '.ag-header-cell[col-id="ag-Grid-SelectionColumn"] input'

test('partial-selection delete refills the underfilled row window without a refresh', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  // 320 rows: the initial window loads INITIAL_ROW_LOAD (300), leaving 20 beyond
  // it — exactly the shape where the pre-fix grid stranded the kept row alone.
  const { tableId, sheetId } = await seedSheet(api, 320)

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v0', { timeout: 15_000 })

  // Select every loaded row via the header checkbox, then unselect row 5.
  // (The topbar button reads "Delete (300 of 320)" — match the leading count.)
  await page.locator(SELECT_ALL).check()
  await expect(page.getByRole('button', { name: /delete \(300/i })).toBeVisible({ timeout: 5_000 })
  await page.locator(SEL_CHECKBOX(5)).uncheck()
  const delBtn = page.getByRole('button', { name: /delete \(299/i })
  await expect(delBtn).toBeVisible()

  await delBtn.click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText(/299 rows deleted/i)).toBeVisible({ timeout: 15_000 })

  // THE FIX: with NO page reload, the kept row is still there AND the 20
  // survivors from beyond the old window appear under it (silent refill).
  // Pre-fix, only v5 showed and v300..v319 stayed invisible until refresh.
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v5', { timeout: 10_000 })
  await expect(page.locator(DATA_CELL(1)).first()).toHaveText('v300', { timeout: 10_000 })
  await expect(page.locator(DATA_CELL(20)).first()).toHaveText('v319')

  // Server truth matches: 21 survivors (320 - 299).
  const fresh = await getSheet(api, sheetId)
  expect(fresh.data.totalRows).toBe(21)
  await api.dispose()
})

import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE } from './helpers'

// Smoke for the empty-filter-delete stranding bug:
// Filtering a column to "empty only" then deleting those rows used to drop the
// user to the "Ready for data / Import a CSV" empty state (it replaces the whole
// grid, including the only UI that can clear the filter) — stranding them with
// no way back to the surviving non-empty rows. The fix keeps SheetGrid mounted
// when a filter is active, so AGGridSpreadsheet's own zero-row branch shows the
// "All rows are hidden by a column filter" message + a working Clear filter button.

test.describe('empty-filter delete stranding', () => {
  const DATA_HEADER = '.ag-header-cell[col-id^="col_"]'

  test('filter empty-only, delete those rows, is NOT stranded on import state', async ({ page, context }) => {
    const api = await authedApi()
    await context.addCookies((await api.storageState()).cookies)
    // 5 rows; blank rows 1,2,3 so the column is a mix of empty + non-empty.
    const { tableId, sheetId } = await seedSheet(api, 5)
    const blanks = [1, 2, 3].map((rowIndex) => ({ rowIndex, columnName: 'val', value: '' }))
    expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates: blanks } })).ok()).toBeTruthy()

    await page.goto(`${BASE}/table/${tableId}`)
    // v0 is row 0 (non-empty); wait for the grid to be live.
    await expect(page.locator('.ag-row[row-index="0"] [col-id^="col_"]').first())
      .toHaveText('v0', { timeout: 15_000 })

    // Filter the column to "empty only" via its header context menu.
    await page.locator(DATA_HEADER).first().click({ button: 'right' })
    await page.getByText('Show empty only', { exact: true }).click()

    // The server-side filter reloads the page to the 3 empty rows. They render as
    // blank data cells; assert the count by the selection checkboxes present.
    await expect(page.locator('.ag-row [col-id="ag-Grid-SelectionColumn"] input'))
      .toHaveCount(3, { timeout: 15_000 })

    // Select all filtered (empty) rows via the header select-all checkbox, then delete.
    await page.locator('.ag-header-cell[col-id="ag-Grid-SelectionColumn"] input').check()
    await page.getByRole('button', { name: /delete \(\d+\)/i }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click() // confirm dialog

    // THE FIX: we must NOT land on the import empty state. Instead the grid stays
    // mounted and shows the filter-aware empty message with a Clear filter button.
    await expect(page.getByText('Ready for data')).toBeHidden({ timeout: 15_000 })
    await expect(page.getByText(/All rows are hidden by a column filter/i))
      .toBeVisible({ timeout: 15_000 })
    const clearBtn = page.getByRole('button', { name: /clear filter/i })
    await expect(clearBtn).toBeVisible()

    // Clearing the filter must reveal the surviving non-empty rows (v0, v4).
    await clearBtn.click()
    await expect(page.locator('[col-id^="col_"]').filter({ hasText: 'v0' }).first())
      .toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[col-id^="col_"]').filter({ hasText: 'v4' }).first())
      .toBeVisible({ timeout: 15_000 })

    // DB truth: the 3 empty rows are gone, the 2 non-empty survive.
    const fresh = await getSheet(api, sheetId)
    expect(fresh.data.totalRows).toBe(2)
    const vals = fresh.data.rows.map((r: any) => r.data.val).sort()
    expect(vals).toEqual(['v0', 'v4'])
    await api.dispose()
  })
})

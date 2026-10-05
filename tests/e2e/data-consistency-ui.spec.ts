import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE } from './helpers'

// Browser-driven E2E coverage for the data-consistency / state-sync fixes:
// edit persistence, stale-selection-after-sort (C2), and edit-then-delete
// no-resurrect (H1). API-level coverage lives in data-consistency-api.spec.ts.
// Cookie-based auth + shared sheet seeding live in ./helpers.

// ---------------------------------------------------------------------------
// UI: edit persistence + stale-selection-after-sort (C2)
// ---------------------------------------------------------------------------
test.describe('UI', () => {
  // The data column's col-id is an opaque, stable token (colIdFor) — NOT the
  // field name — so target data cells/headers by the 'col_' prefix. seedSheet
  // creates exactly one data column, so this is unambiguous.
  const DATA_CELL = (row: number) => `.ag-row[row-index="${row}"] [col-id^="col_"]`
  const DATA_HEADER = '.ag-header-cell[col-id^="col_"]'

  test('a cell edit persists across a reload', async ({ page, context }) => {
    const api = await authedApi()
    // Share the cookie with the browser context.
    const cookies = await api.storageState()
    await context.addCookies(cookies.cookies)
    const { tableId, sheetId } = await seedSheet(api, 3)

    await page.goto(`${BASE}/table/${tableId}`)
    const cell = page.locator(DATA_CELL(0)).first()
    await expect(cell).toBeVisible({ timeout: 15_000 })
    await expect(cell).toHaveText('v0')

    await cell.dblclick()
    // ControlOrMeta = Cmd on macOS (Control+A there is move-to-line-start, which
    // would prepend instead of replace). Select-all then overtype.
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('EDITED')
    await page.keyboard.press('Enter')
    // Give autosave (100ms debounce) time to flush.
    await page.waitForTimeout(800)

    await page.reload()
    await expect(
      page.locator(DATA_CELL(0)).filter({ hasText: 'EDITED' }).first(),
    ).toBeVisible({ timeout: 15_000 })

    // DB confirms it too.
    const fresh = await getSheet(api, sheetId)
    expect(fresh.data.rows.find((r: any) => r.rowIndex === 0).data.val).toBe('EDITED')
    await api.dispose()
  })

  test('row selection is cleared after a sort (no stale Delete button)', async ({ page, context }) => {
    const api = await authedApi()
    const cookies = await api.storageState()
    await context.addCookies(cookies.cookies)
    const { tableId } = await seedSheet(api, 4)

    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator(DATA_CELL(0)).first()).toBeVisible({ timeout: 15_000 })

    // Select 2 rows via the AG Grid selection-column checkboxes.
    await page.locator(`.ag-row[row-index="0"] [col-id="ag-Grid-SelectionColumn"] input`).click()
    await page.locator(`.ag-row[row-index="1"] [col-id="ag-Grid-SelectionColumn"] input`).click()
    // The header Delete (N) button should appear.
    await expect(page.getByRole('button', { name: /delete \(\d+\)/i })).toBeVisible({ timeout: 5_000 })

    // Sort via the column header right-click context menu.
    await page.locator(DATA_HEADER).first().click({ button: 'right' })
    await page.getByText(/sort ascending/i).first().click()

    // After the sort + reload, the selection (and its Delete button) must be gone.
    await expect(page.getByRole('button', { name: /delete \(\d+\)/i })).toBeHidden({ timeout: 15_000 })
    await api.dispose()
  })

  test('editing a row then deleting it does not resurrect it (H1)', async ({ page, context }) => {
    const api = await authedApi()
    await context.addCookies((await api.storageState()).cookies)
    const { tableId, sheetId } = await seedSheet(api, 3) // v0, v1, v2

    // Throttle the autosave PUT so the edit is genuinely in flight when we
    // delete the same row. Pre-fix, the delete fired first and the late PUT
    // upserted (resurrected) the row; the fix makes delete await the flush.
    await page.route('**/api/sheets/*/data', async (route) => {
      if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 1200))
      await route.continue()
    })

    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator(DATA_CELL(1)).first()).toHaveText('v1', { timeout: 15_000 })

    // Edit row 1 → fires a throttled PUT that stays in flight.
    await page.locator(DATA_CELL(1)).first().dblclick()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('CHANGED')
    await page.keyboard.press('Enter')

    // Immediately select + delete row 1 while that PUT is still in flight.
    await page.locator(`.ag-row[row-index="1"] [col-id="ag-Grid-SelectionColumn"] input`).check()
    await page.getByRole('button', { name: /delete \(\d+\)/i }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click() // confirm dialog

    // Let the throttled PUT + delete + any late upsert fully settle.
    await page.waitForTimeout(3000)
    await page.reload()
    await expect(page.locator(DATA_CELL(0)).first()).toBeVisible({ timeout: 15_000 })

    // The deleted row must be GONE — not resurrected by the in-flight edit.
    const fresh = await getSheet(api, sheetId)
    expect(fresh.data.totalRows).toBe(2)
    expect(fresh.data.rows.find((r: any) => r.rowIndex === 1)).toBeUndefined()
    await api.dispose()
  })
})

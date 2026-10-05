import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE } from './helpers'

// MANUAL SMOKE (not part of the data-consistency suite): verifies the row-delete
// UX fix — confirm popup closes instantly + "Deleting…" toast, selection clears
// (rows un-highlight, topbar count gone), and a fire-and-forget delete on sheet A
// doesn't corrupt sheet B after a tab switch. Screenshots are written to
// SHOT_DIR for human inspection.
const SHOT_DIR = process.env.SHOT_DIR || '/tmp'
const DATA_CELL = (row: number) => `.ag-row[row-index="${row}"] [col-id^="col_"]`
const SEL_CHECKBOX = (row: number) =>
  `.ag-row[row-index="${row}"] [col-id="ag-Grid-SelectionColumn"] input`

test.describe('row-delete smoke', () => {
  test('1+2: popup closes instantly, Deleting toast, selection cleared', async ({ page, context }) => {
    const api = await authedApi()
    await context.addCookies((await api.storageState()).cookies)
    const { tableId, sheetId } = await seedSheet(api, 6) // v0..v5

    const logs: string[] = []
    page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v0', { timeout: 15_000 })

    // Select rows 0,1,2 via the AG Grid selection checkboxes.
    await page.locator(SEL_CHECKBOX(0)).check()
    await page.locator(SEL_CHECKBOX(1)).check()
    await page.locator(SEL_CHECKBOX(2)).check()
    const delBtn = page.getByRole('button', { name: /delete \(\d+\)/i })
    await expect(delBtn).toBeVisible({ timeout: 5_000 })
    await expect(delBtn).toHaveText(/delete \(3\)/i)
    await page.screenshot({ path: `${SHOT_DIR}/01-selected-3.png` })

    // Throttle the bulk-delete so the "popup closes instantly" + "Deleting…" toast
    // are observable BEFORE the server responds. Without this the request is so
    // fast the loading state would be a blink.
    await page.route('**/api/sheets/*/rows/bulk-delete', async (route) => {
      await new Promise((r) => setTimeout(r, 1500))
      await route.continue()
    })

    await delBtn.click()
    const confirm = page.getByRole('button', { name: 'Delete', exact: true })
    await expect(confirm).toBeVisible()
    await confirm.click()

    // (1a) The confirm dialog must be GONE immediately — not awaiting the delete.
    await expect(confirm).toBeHidden({ timeout: 1_000 })
    // (1b) The "Deleting…" loading toast should be visible while the throttled
    // request is in flight.
    await expect(page.getByText(/deleting 3 rows/i)).toBeVisible({ timeout: 1_000 })
    await page.screenshot({ path: `${SHOT_DIR}/02-deleting-toast.png` })

    // After the request lands: success toast.
    await expect(page.getByText(/3 rows deleted/i)).toBeVisible({ timeout: 5_000 })

    // (2) Selection cleared: topbar "Delete (N)" button gone, no checked rows.
    await expect(page.getByRole('button', { name: /delete \(\d+\)/i })).toBeHidden({ timeout: 5_000 })
    await expect(page.locator('.ag-row.ag-row-selected')).toHaveCount(0)
    await page.screenshot({ path: `${SHOT_DIR}/03-after-delete-no-selection.png` })

    // Rows actually gone on the server (3 of 6 remain).
    const fresh = await getSheet(api, sheetId)
    expect(fresh.data.totalRows).toBe(3)

    logs.length && console.log('CONSOLE:\n' + logs.join('\n'))
    await api.dispose()
  })

  test('3: delete on table A then immediately open table B — B intact, A reconciled', async ({ page, context }) => {
    // The cross-sheet guard (activeSheetIdRef) protects against a fire-and-forget
    // delete completing AFTER the user navigated away. Faithful repro: TWO
    // tables. seedSheet wipes the account's tables each call, so build both by
    // hand here instead of two seedSheet() calls.
    const api = await authedApi()
    await context.addCookies((await api.storageState()).cookies)

    // Clear any leftover tables, then create A and B (5 rows each, column 'val').
    const existing = await (await api.get('/api/tables')).json()
    if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
    const mk = async (label: string) => {
      const tbl = await (await api.post('/api/tables', { data: { name: `${label}_${Date.now()}_${Math.random()}` } })).json()
      const sheetId = tbl.sheets[0].id
      await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'val' } })
      await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: 4 } }) // +4 → 5 rows
      const updates = Array.from({ length: 5 }, (_, i) => ({ rowIndex: i, columnName: 'val', value: `${label}${i}` }))
      await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })
      return { tableId: tbl.id, sheetId }
    }
    const a = await mk('A') // A0..A4
    const b = await mk('B') // B0..B4

    await page.goto(`${BASE}/table/${a.tableId}`)
    await expect(page.locator(DATA_CELL(0)).first()).toHaveText('A0', { timeout: 15_000 })

    // Select A rows 0,1.
    await page.locator(SEL_CHECKBOX(0)).check()
    await page.locator(SEL_CHECKBOX(1)).check()
    await expect(page.getByRole('button', { name: /delete \(2\)/i })).toBeVisible()

    // Throttle A's bulk-delete so it's STILL IN FLIGHT when we navigate to B.
    await page.route('**/api/sheets/*/rows/bulk-delete', async (route) => {
      await new Promise((r) => setTimeout(r, 2000))
      await route.continue()
    })

    await page.getByRole('button', { name: /delete \(2\)/i }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    // Popup closed; delete still in flight. Immediately switch to table B.
    await page.goto(`${BASE}/table/${b.tableId}`)
    await expect(page.locator(DATA_CELL(0)).first()).toHaveText('B0', { timeout: 15_000 })
    await page.screenshot({ path: `${SHOT_DIR}/04-switched-to-B-mid-delete.png` })

    // Let any in-flight work settle while we're on B.
    await page.waitForTimeout(2500)

    // (3a) THE GUARD: B's grid must be UNTOUCHED — all 5 B rows present. Pre-fix,
    // A's optimistic removal (filtering row indices 0,1) would apply to whatever
    // sheet is showing NOW (B), wiping B0/B1. The activeSheetIdRef guard prevents it.
    for (let i = 0; i < 5; i++) {
      await expect(page.locator(DATA_CELL(i)).first()).toHaveText(`B${i}`)
    }
    await page.screenshot({ path: `${SHOT_DIR}/05-B-intact-after-A-delete.png` })

    // (3b) Server truth: B never touched (5). A: a full-page navigation aborts the
    // in-flight foreground delete request (browsers cancel pending fetches on nav),
    // so A is left at its original 5 — NOT a partial/corrupt state. The atomic
    // server transaction guarantees all-or-nothing; here it's "nothing" because the
    // request never completed. Either outcome (3 if it landed, 5 if cancelled) is
    // consistent; assert the consistency, not a specific count.
    const freshA = await getSheet(api, a.sheetId)
    expect([3, 5]).toContain(freshA.data.totalRows)
    const freshB = await getSheet(api, b.sheetId)
    expect(freshB.data.totalRows).toBe(5)
    await api.dispose()
  })
})

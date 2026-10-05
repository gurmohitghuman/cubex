import { test, expect, request as pwRequest, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, getSheet, BASE, makeAccessToken } from './helpers'

// P1-2 regression: a FROZEN autosave queue must not flush stale-index edits onto
// the wrong rows after an out-of-band sort.
//
// The structural change-poll path runs a waitForSaves() barrier before its loud
// reload. If the queue is frozen (autosave hit maxAttempts → 'error' state, no
// auto-retry), the barrier TIMES OUT and the edits never flush and never 409.
// The bug: the old code discarded the barrier result and reloaded anyway, which
// reseeded rowGenerationRef to the NEW generation — so the still-queued
// old-index edits would later flush under the new generation and land on
// whatever rows now occupy those indices. The fix drops the frozen queue (+
// toast) before the reload.
//
// This test forces the frozen state by blocking the autosave PUT, edits a cell,
// then sorts via /api/v1 (moves row_generation) and asserts the stale edit never
// appears on any row after the user retries.

const DATA_CELL = (row: number) => `.ag-row[row-index="${row}"] [col-id^="col_"]`

// Delegates to helpers.makeAccessToken, which mints straight into the test DB.
async function makeToken(api: APIRequestContext): Promise<string> {
  return makeAccessToken(api, ['read', 'write'], 'e2e frozen queue')
}

test('frozen autosave queue is dropped (not mis-flushed) when a sort moves row_generation', async ({ page, context }) => {
  const api = await authedApi()
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  const { tableId, sheetId } = await seedSheet(api, 4) // val: v0, v1, v2, v3

  const v1 = await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${await makeToken(api)}` },
  })

  // Block every autosave PUT so the queue exhausts maxAttempts and freezes in
  // its 'error' state (~1.5s: backoff 500ms + 1000ms across 3 attempts).
  let blockSaves = true
  await page.route('**/api/sheets/*/data', (route) => {
    if (blockSaves && route.request().method() === 'PUT') return route.abort('failed')
    return route.continue()
  })

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v0', { timeout: 15_000 })

  // Edit row 0 → autosave fires, is blocked, and freezes after maxAttempts.
  const cell0 = page.locator(DATA_CELL(0)).first()
  await cell0.dblclick()
  await page.keyboard.type('STALE')
  await page.keyboard.press('Enter')
  // The queue exhausts its retries (backoff 500ms + 1000ms) and freezes in the
  // 'error' state — surfaced as a "Save failed · Retry" pill. Wait for it, so we
  // KNOW the queue is frozen (not merely slow) before we sort.
  await expect(page.getByText('Save failed')).toBeVisible({ timeout: 15_000 })

  // Sort DESC via /api/v1 → row_generation moves → the open tab's change poll
  // fires the structural path. v3 > v2 > v1 > v0 (and 'STALE' is only local,
  // never persisted), so after a clean reload row 0 must be v3.
  const sort = await v1.post(`/api/v1/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'desc' } })
  expect(sort.status()).toBe(200)

  // The tab loud-reloads to the sorted order. Row 0 becomes v3 — NOT 'STALE'.
  // This reseeds rowGenerationRef to the NEW generation.
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v3', { timeout: 15_000 })

  // Now the critical step: unblock saves and RETRY the frozen edit. Under the
  // bug, the stale old-index edit flushes under the NEW generation (the server
  // fence only compares generations) and lands on whatever row now sits at that
  // index. Under the fix, the queue was already dropped on the structural
  // reload, so the "Save failed" pill is gone and there is nothing to flush.
  blockSaves = false
  const retry = page.getByRole('button', { name: /^retry$/i })
  if (await retry.isVisible().catch(() => false)) {
    await retry.click()
    await page.waitForTimeout(1500)
  }

  // Authoritative check via the API: no row anywhere holds the stale edit.
  const sheet = await getSheet(api, sheetId)
  const rows = (sheet.data.rows as Array<{ rowIndex: number; data: Record<string, string> }>)
    .slice()
    .sort((a, b) => a.rowIndex - b.rowIndex)
  const values = rows.map((r) => r.data.val)
  expect(values).not.toContain('STALE')
  // And the sorted order is intact end to end.
  expect(values.slice(0, 4)).toEqual(['v3', 'v2', 'v1', 'v0'])

  await v1.dispose()
})

// The race, end-to-end flavor: a data-only change (v1 append) lands right
// after a structural sort, so a SILENT reload can overlay the about-to-be-
// dropped stale edits onto the post-sort rows while the barrier waits. The fix
// reloads UNCONDITIONALLY after dropping a frozen queue, clearing any overlay.
//
// NOTE: the exact race window (silent reload advancing the generation BEFORE the
// structural handler resumes) is timing-dependent and not guaranteed to trigger
// from outside the app, so this e2e is a best-effort integration check. The
// DETERMINISTIC coverage of the fix's decision is the unit test on
// shouldLoudReloadAfterBarrier (tests/unit/live-update-decision.test.ts).
test('frozen queue + a data-only silent reload during the barrier does not leave a stale overlay', async ({ page, context }) => {
  const api = await authedApi()
  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  const { tableId, sheetId } = await seedSheet(api, 4) // v0..v3

  const v1 = await pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${await makeToken(api)}` },
  })

  let blockSaves = true
  await page.route('**/api/sheets/*/data', (route) => {
    if (blockSaves && route.request().method() === 'PUT') return route.abort('failed')
    return route.continue()
  })

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v0', { timeout: 15_000 })

  const cell0 = page.locator(DATA_CELL(0)).first()
  await cell0.dblclick()
  await page.keyboard.type('STALE')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Save failed')).toBeVisible({ timeout: 15_000 })

  // Structural bump (sort desc) → starts the barrier. Then, WHILE the barrier is
  // waiting out its timeout, a data-only bump (v1 append) fires a silent reload
  // that overlays the frozen edit onto the sorted rows.
  const sort = await v1.post(`/api/v1/sheets/${sheetId}/sort`, { data: { column: 'val', direction: 'desc' } })
  expect(sort.status()).toBe(200)
  const append = await v1.post(`/api/v1/sheets/${sheetId}/rows`, { data: { rows: [{ data: { val: 'APPENDED' } }] } })
  expect(append.status()).toBe(201)

  // After the fix: the loud reload runs unconditionally on drop, so the grid
  // shows the true sorted+appended state with NO stale overlay. Row 0 = v3, and
  // the appended row is present.
  await expect(page.locator(DATA_CELL(0)).first()).toHaveText('v3', { timeout: 15_000 })
  await expect(page.locator(DATA_CELL(4)).first()).toHaveText('APPENDED', { timeout: 15_000 })

  blockSaves = false
  const retry = page.getByRole('button', { name: /^retry$/i })
  if (await retry.isVisible().catch(() => false)) {
    await retry.click()
    await page.waitForTimeout(1500)
  }

  // No cell on the grid shows the stale value.
  await expect(page.getByText('STALE')).toHaveCount(0)

  const sheet = await getSheet(api, sheetId)
  const values = (sheet.data.rows as Array<{ data: Record<string, string> }>).map((r) => r.data.val)
  expect(values).not.toContain('STALE')
  expect(values).toContain('APPENDED')

  await v1.dispose()
})

import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { authedApi, seedSheet, BASE } from './helpers'

// Regression: "Run Missing or Errors" on an AI column WHILE an empty-filter on
// that column hides all-but-the-error rows crashed the page with
//   Unexpected Application Error! Cannot read properties of undefined (reading 'map')
// from useGridHandlers.ts's column-state sync useLayoutEffect.
//
// Mechanism: the rerun seeds '⏳ Processing...' into the empty (error/missing)
// cells, so the "empty only" server filter now matches ZERO rows. AGGridSpreadsheet
// flips to its zero-row "All rows are hidden by a column filter" branch, which
// UNMOUNTS <AgGridReact> and destroys the grid — but the hook still holds the
// (now-destroyed) gridApi. The same-cycle `columns`/placeholder change re-fires the
// column-state useLayoutEffect, which calls gridApi.getColumnState() on the dead
// grid → returns undefined → `.map` throws and React unmounts the whole tree into
// the error boundary. The fix guards getColumnState() (isDestroyed + ?? []).
//
// A real AI run needs OpenRouter (absent in the harness), and the crash is pure
// client render after the rerun POST — so we seed a completed AI run + mixed
// empty/filled cells directly into the test DB the server reads (like
// ai-commit-superseded.spec.ts), set the empty filter, then drive the real UI.
function openTestDb(): Database.Database {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
  if (/(^|\/)cubex\.db$/.test(dbPath)) throw new Error('refusing to open the real cubex.db')
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  return db
}
function seedUserId(db: Database.Database): string {
  const row = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined
  if (!row) throw new Error('seed user not found in test DB')
  return row.id
}

test('Run Missing or Errors with an active empty-filter does not crash the page', async ({ page, context }) => {
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await seedSheet(api, 4) // rows 0..3, column 'val'
  const db = openTestDb()
  try {
    const userId = seedUserId(db)
    const OUT = 'Enrich (Output)'

    // A COMPLETED AI run on 'Enrich (Output)' — makes the column AI-typed so the
    // header menu shows "Run Missing or Errors". Plus ai_results so the column
    // type resolves to ai-output.
    const runId = randomUUID()
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, total_rows, processed_rows)
                VALUES (?, ?, ?, ?, 'p', 'completed', 4, 4)`).run(runId, sheetId, userId, OUT)

    // Mixed cells: rows 0,2 filled; rows 1,3 EMPTY (the missing/error rows). Add the
    // Output column to column_order so it renders. Then set the empty-filter to
    // "empty only" on the Output column so only rows 1,3 show.
    const setCell = db.prepare(`UPDATE rows SET data = json_set(data, '$."Enrich (Output)"', ?) WHERE sheet_id = ? AND user_id = ? AND row_index = ?`)
    const insResult = db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status) VALUES (?, ?, ?, ?, ?, 'completed')`)
    setCell.run('alpha', sheetId, userId, 0)
    setCell.run('', sheetId, userId, 1)
    setCell.run('gamma', sheetId, userId, 2)
    setCell.run('', sheetId, userId, 3)
    insResult.run(randomUUID(), runId, userId, 0, 'alpha')
    insResult.run(randomUUID(), runId, userId, 2, 'gamma')

    // Append Output to column_order + set the empty filter on it.
    const sheetRow = db.prepare('SELECT column_order FROM sheets WHERE id = ?').get(sheetId) as { column_order: string | null }
    const order = sheetRow.column_order ? JSON.parse(sheetRow.column_order) as string[] : ['val']
    if (!order.includes(OUT)) order.push(OUT)
    db.prepare('UPDATE sheets SET column_order = ?, empty_filter = ? WHERE id = ?')
      .run(JSON.stringify(order), JSON.stringify({ [OUT]: 'empty' }), sheetId)

    // Surface any page crash: the app's error boundary renders this text.
    const sawCrash = page.locator('text=Unexpected Application Error')

    await page.goto(`${BASE}/table/${tableId}`)
    // The filtered view shows the 2 empty rows (1,3). Wait for the grid.
    await expect(page.locator('.ag-header-cell[col-id^="col_"]').first()).toBeVisible({ timeout: 15_000 })
    await expect(sawCrash).toBeHidden()

    // Open the Output column's header menu and click "Run Missing or Errors".
    // The Output column is the 2nd data column; target it by its header text.
    const outHeader = page.locator('.ag-header-cell', { hasText: 'Enrich (Output)' }).first()
    await outHeader.click({ button: 'right' })
    await page.getByText('Run Missing or Errors', { exact: false }).click()

    // The bug: clicking it crashed the page. Assert the error boundary NEVER shows,
    // and the app stays interactive (header still present) over the reload that
    // follows the rerun (which is what flips the grid to its zero-row branch).
    await expect(sawCrash).toBeHidden({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: /import/i }).first()).toBeVisible()
    // A short settle to let the silent reload + column-state effect run.
    await page.waitForTimeout(1500)
    await expect(sawCrash).toBeHidden()
  } finally {
    db.close()
    await api.dispose()
  }
})

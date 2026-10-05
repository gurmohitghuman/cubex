// BROWSER SMOKE for the perf #1 client half: load the real app on a sheet with an
// active AI run, let it auto-connect the SSE stream, then stream ai_results in while
// asserting cells flip ⏳→value LIVE (the coalescing buffer + WeakMap path), and that
// the grid stays interactive (scroll + edit) during the stream. Screenshots captured.
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { authedApi, seedSheet, BASE } from './helpers'

const COL = 'Enrich (Output)'
const PLACEHOLDER = '⏳ Processing...'
const ROWS = 40   // enough to scroll; small enough to stream quickly

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
  if (!row) throw new Error('seed user not found')
  return row.id
}

test('perf smoke: AI results stream into the grid live while it stays interactive', async ({ page, context }) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, ROWS)

  // Create a RUNNING ai run + stamp every row's output cell with the ⏳ placeholder
  // (exactly what ai-run-start does). The app auto-connects the SSE stream on load.
  const db = openTestDb()
  const runId = randomUUID()
  const userId = seedUserId(db)
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, total_rows, processed_rows)
              VALUES (?, ?, ?, ?, 'smoke', 'running', ?, 0)`).run(runId, sheetId, userId, COL, ROWS)
  // Register the column + placeholder cells.
  const setCell = db.prepare(`UPDATE rows SET data = json_set(data, '$."${COL}"', ?) WHERE sheet_id = ? AND user_id = ? AND row_index = ?`)
  for (let i = 0; i < ROWS; i++) setCell.run(PLACEHOLDER, sheetId, userId, i)
  // Append the column to column_order so getSheetColumns surfaces it.
  const so = db.prepare('SELECT column_order FROM sheets WHERE id = ?').get(sheetId) as { column_order: string | null }
  const order = so.column_order ? JSON.parse(so.column_order) : ['val']
  if (!order.includes(COL)) { order.push(COL); db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(order), sheetId) }
  db.close()

  const cookies = await api.storageState()
  await context.addCookies(cookies.cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await page.locator('.ag-row').first().waitFor({ state: 'visible', timeout: 30_000 })

  // The run is live (Pause/Stop in the header). AG Grid addresses cells by an
  // OPAQUE colId, not the column name (stable-colId design) — so we assert on row
  // TEXT content. Row 0 has no result value yet (only the ⏳ spinner placeholder).
  const row0 = page.locator(`.ag-row[row-index="0"]`).first()
  await expect(page.getByRole('button', { name: /stop/i })).toBeVisible({ timeout: 10_000 })
  await expect(row0).not.toContainText('AI result row 0')
  await page.screenshot({ path: 'test-results/smoke-1-placeholders.png' })

  // Stream results in batches by inserting ai_results rows (what the worker does).
  // The open SSE stream's 400ms poll picks them up → SSE 'result' event → client
  // coalescing buffer → setSheetData (one per frame) → WeakMap rowData → AG Grid.
  const stream = (from: number, to: number) => {
    const sdb = openTestDb()
    const ins = sdb.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status) VALUES (?, ?, ?, ?, ?, 'completed')`)
    const cell = sdb.prepare(`UPDATE rows SET data = json_set(data, '$."${COL}"', ?) WHERE sheet_id = ? AND user_id = ? AND row_index = ?`)
    const tx = sdb.transaction(() => {
      for (let i = from; i < to; i++) {
        const v = `AI result row ${i}`
        ins.run(randomUUID(), runId, userId, i, v)
        cell.run(v, sheetId, userId, i)
      }
    })
    tx()
    sdb.close()
  }

  // First half streams in; assert results flip ⏳ → value LIVE (no manual reload).
  // This is the core perf path: SSE → coalescing buffer → setSheetData → WeakMap
  // rowData → AG Grid. Values type in char-by-char (LoadingCellRenderer), so we
  // assert on the grid CONTAINING the streamed values (robust to the typing
  // animation + AG Grid cell virtualization, unlike a single-cell text poll).
  stream(0, ROWS / 2)
  const grid = page.locator('.ag-center-cols-container')
  await expect(grid).toContainText('AI result row 0', { timeout: 10_000 })
  await expect(grid).toContainText('AI result row 5', { timeout: 10_000 })
  await page.screenshot({ path: 'test-results/smoke-2-first-half.png' })

  // While the rest streams, interact with the grid to prove it stays responsive:
  // edit the 'val' cell of row 2 (NOT run-locked). Target the cell by its current
  // text 'v2' (robust against opaque colIds + cell ordering), double-click to edit.
  stream(ROWS / 2, ROWS)
  await page.waitForTimeout(300)
  const valCell = page.locator(`.ag-row[row-index="2"] .ag-cell`, { hasText: /^v2$/ }).first()
  await valCell.scrollIntoViewIfNeeded()
  await valCell.dblclick()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('edited-during-run')
  await page.keyboard.press('Enter')

  // The tail of the stream landed (a high-index row's value shows after scroll).
  await page.locator(`.ag-row[row-index="${ROWS - 1}"]`).scrollIntoViewIfNeeded().catch(() => {})
  await expect(grid).toContainText(`AI result row ${ROWS - 1}`, { timeout: 10_000 })

  // The edit made DURING the run persisted in the grid (scroll back up to it).
  await page.locator(`.ag-row[row-index="2"]`).scrollIntoViewIfNeeded().catch(() => {})
  await expect(grid).toContainText('edited-during-run', { timeout: 8_000 })
  await page.screenshot({ path: 'test-results/smoke-3-complete.png' })

  // Finalize the run so the stream closes cleanly (terminal status).
  const fdb = openTestDb()
  fdb.prepare("UPDATE ai_runs SET status = 'completed', processed_rows = ? WHERE id = ?").run(ROWS, runId)
  fdb.close()
  await page.waitForTimeout(1500)  // let terminal status + silent reload settle
  await page.screenshot({ path: 'test-results/smoke-4-finalized.png' })
})

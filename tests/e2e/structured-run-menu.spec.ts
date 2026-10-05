import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { authedApi, seedSheet, BASE } from './helpers'

// The column menu on a structured AI run (several typed columns from one call
// per row): "Run All Rows" on any of its columns reruns that run on every row
// (it used to say "Configure AI column first"), and "Stop AI Run" shows on its
// columns while it runs (it was keyed to "(Output)" names only). The runs are
// seeded into the test DB (no OpenRouter key here), as in
// run-missing-empty-filter-crash.spec.ts.
function openTestDb(): Database.Database {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
  if (/(^|\/)cubex\.db$/.test(dbPath)) throw new Error('refusing to open the real cubex.db')
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  return db
}

const SPECS = JSON.stringify([
  { columnName: 'Fit', type: 'number', description: '1 to 10' },
  { columnName: 'Why', type: 'string', description: 'One sentence' },
])

test('column menu: Run All Rows and Stop AI Run on a structured run', async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await context.addCookies((await api.storageState()).cookies)
  const { tableId, sheetId } = await seedSheet(api, 3)
  const db = openTestDb()
  try {
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id
    const insertRun = db.prepare(`
      INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, total_rows, processed_rows,
        output_columns, status_column, created_at)
      VALUES (?, ?, ?, 'Score (Status)', 'Rate /val', 'openai/gpt-4o-mini', ?, 3, ?, ?, 'Score (Status)', ?)
    `)
    insertRun.run(randomUUID(), sheetId, userId, 'completed', 3, SPECS, '2020-01-01 00:00:00')
    db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?')
      .run(JSON.stringify(['val', 'Fit', 'Why', 'Score (Status)']), sheetId)
    const latestRun = () => db.prepare(`
      SELECT id, status, total_rows, output_columns, placeholder_work FROM ai_runs
      WHERE sheet_id = ? AND column_name = 'Score (Status)' ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(sheetId) as { id: string; status: string; total_rows: number; output_columns: string | null; placeholder_work: string | null }

    await page.goto(`${BASE}/table/${tableId}`)
    const why = page.locator('.ag-header-cell', { hasText: 'Why' }).first()
    await expect(why).toBeVisible({ timeout: 15_000 })

    // Run All Rows on a typed column → confirm → a rerun of the structured run on all 3 rows.
    await why.click({ button: 'right' })
    await expect(page.getByText('Stop AI Run')).toHaveCount(0) // nothing running yet
    await page.getByText('Run All Rows').click()
    await page.getByRole('button', { name: 'Run all rows', exact: true }).click()
    await expect(page.getByText('Re-running AI for 3 rows')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => latestRun().total_rows).toBe(3)
    expect(latestRun().output_columns).toBe(SPECS)

    // That rerun fails fast (no key). Once it's done, a running structured run
    // shows "Stop AI Run" on its typed column, and the item stops that run.
    await expect.poll(() => { const r = latestRun(); return r.status !== 'running' && r.status !== 'pending' && !r.placeholder_work }).toBe(true)
    const runningId = randomUUID()
    insertRun.run(runningId, sheetId, userId, 'running', 0, SPECS, new Date().toISOString().replace('T', ' ').slice(0, 19))
    await page.reload()
    await expect(why).toBeVisible({ timeout: 15_000 })
    await why.click({ button: 'right' })
    await page.getByText('Stop AI Run').click()
    await expect.poll(() => (db.prepare('SELECT status FROM ai_runs WHERE id = ?').get(runningId) as { status: string }).status)
      .toBe('cancelled')
  } finally {
    db.close()
  }
})

import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

// P2-8 (a missed path): PUT /api/ai/results/:id accepts a value that
// POST /api/ai/runs/:id/commit later writes straight into rows.data via
// upsertCellsBatch — an unbounded cell write. The PUT now clamps the stored
// output_value to the enrichment cap, so the committed cell is bounded.

const ENRICHMENT = 200000

function openTestDb(): Database.Database {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
  if (/(^|\/)cubex\.db$/.test(dbPath)) throw new Error('refusing to open the real cubex.db')
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  return db
}

test('ai-results commit path clamps an oversize value to the enrichment cap', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1) // one row, index 0
  const db = openTestDb()
  try {
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id
    const COL = 'Enrich (Output)'
    const runId = randomUUID()
    const resultId = randomUUID()

    // A terminal run + a pending result row for row 0 (the shapes the PUT/commit
    // endpoints operate on).
    db.prepare(`
      INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, total_rows, processed_rows, created_at)
      VALUES (?, ?, ?, ?, 'p', 'completed', 1, 1, '2020-01-01 00:00:00')
    `).run(runId, sheetId, userId, COL)
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status)
      VALUES (?, ?, ?, 0, '', 'pending')
    `).run(resultId, runId, userId)

    // PUT an oversize value + accept it — the endpoint clamps output_value.
    const big = 'y'.repeat(ENRICHMENT + 5000)
    const put = await api.put(`/api/ai/results/${resultId}`, { data: { value: big, status: 'accepted' } })
    expect(put.ok()).toBeTruthy()

    // Stored output_value is clamped.
    const stored = (db.prepare('SELECT output_value AS v FROM ai_results WHERE id = ?').get(resultId) as { v: string }).v
    expect(stored.length).toBeLessThanOrEqual(ENRICHMENT)
    expect(stored.length).toBeLessThan(big.length)

    // Commit → the cell in rows.data is the clamped value (not the multi-MB input).
    const commit = await api.post(`/api/ai/runs/${runId}/commit`)
    expect(commit.ok()).toBeTruthy()
    const cell = (db.prepare(`
      SELECT json_extract(data, '$."Enrich (Output)"') AS v
      FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index = 0
    `).get(sheetId, userId) as { v: string }).v
    expect(cell.length).toBeLessThanOrEqual(ENRICHMENT)
    expect(cell.length).toBeLessThan(big.length)
  } finally {
    db.close()
    await api.dispose()
  }
})

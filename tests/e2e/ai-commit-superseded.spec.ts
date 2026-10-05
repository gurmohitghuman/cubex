import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { authedApi, seedSheet } from './helpers'

// Regression: POST /api/ai/runs/:id/commit must REFUSE a superseded run.
//
// A rerun creates a NEW ai_runs row sharing (sheet_id, column_name) with a later
// created_at; its worker writes results straight into rows.data. If an OLDER
// completed run is then committed (e.g. a stale tab still showing its preview),
// its accepted cells would overwrite the values the newer run already wrote. The
// commit handler (server/src/routes/ai-results.ts) now 409s any run that isn't
// the latest created_at (id DESC tie-break) for that (sheet_id, column_name).
//
// A genuine AI run needs OpenRouter (no key in the throwaway harness env), and
// this guard is pure ai_runs DB logic — so we seed two terminal runs + accepted
// results directly into the SAME test DB the server uses, then drive the real
// HTTP commit endpoint. The DB is opened read/write only after refusing the real
// cubex.db.
function openTestDb(): Database.Database {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
  if (/(^|\/)cubex\.db$/.test(dbPath)) throw new Error('refusing to open the real cubex.db')
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  return db
}

// The seed user owns the sheet; commit filters by user_id, so the run rows must
// carry the same user_id. Cubex has one account, so look up that one.
function seedUserId(db: Database.Database): string {
  const row = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined
  if (!row) throw new Error('seed user not found in test DB')
  return row.id
}

test('commit refuses a superseded run and preserves the newer run\'s cells (medium-fix)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3) // rows 0,1,2 with val v0..v2
  const db = openTestDb()
  try {
    const userId = seedUserId(db)
    const COL = 'Enrich (Output)'
    const oldRunId = randomUUID()
    const newRunId = randomUUID()

    // Two terminal ('completed') runs on the SAME (sheet_id, column_name).
    // Explicit, distinct created_at makes "older vs newer" deterministic
    // regardless of clock resolution; the guard also tie-breaks on id DESC.
    const insertRun = db.prepare(`
      INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, total_rows, processed_rows, created_at)
      VALUES (?, ?, ?, ?, 'p', 'completed', 3, 3, ?)
    `)
    insertRun.run(oldRunId, sheetId, userId, COL, '2020-01-01 00:00:00')
    insertRun.run(newRunId, sheetId, userId, COL, '2020-01-02 00:00:00')

    // The OLDER run holds accepted results that, if committed, would clobber the
    // column. The NEWER run represents the rerun whose worker already wrote
    // NEW_VALUE into rows.data.
    const insertResult = db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status)
      VALUES (?, ?, ?, ?, ?, 'accepted')
    `)
    for (let i = 0; i < 3; i++) insertResult.run(randomUUID(), oldRunId, userId, i, `OLD_VALUE_${i}`)

    // Simulate the newer run having written its results into the live cells.
    const writeCell = db.prepare(`
      UPDATE rows SET data = json_set(data, '$."Enrich (Output)"', ?)
      WHERE sheet_id = ? AND user_id = ? AND row_index = ?
    `)
    for (let i = 0; i < 3; i++) writeCell.run(`NEW_VALUE_${i}`, sheetId, userId, i)

    // 1) Committing the OLDER (superseded) run is rejected with 409.
    const staleCommit = await api.post(`/api/ai/runs/${oldRunId}/commit`)
    expect(staleCommit.status()).toBe(409)
    expect((await staleCommit.json()).error).toMatch(/superseded/i)

    // 2) The newer run's cells are UNTOUCHED — the stale commit wrote nothing.
    const cells = db.prepare(`
      SELECT row_index AS i, json_extract(data, '$."Enrich (Output)"') AS v
      FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index ASC
    `).all(sheetId, userId) as Array<{ i: number; v: string }>
    expect(cells.map(c => c.v)).toEqual(['NEW_VALUE_0', 'NEW_VALUE_1', 'NEW_VALUE_2'])

    // 3) Committing the NEWEST run is allowed (it's the latest for this column).
    const newCommit = await api.post(`/api/ai/runs/${newRunId}/commit`)
    expect(newCommit.ok()).toBeTruthy()
  } finally {
    db.close()
    await api.dispose()
  }
})

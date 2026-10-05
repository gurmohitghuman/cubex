import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import Database from 'better-sqlite3'
import { authedApi, seedSheet } from './helpers'

// Import the REAL shipped hasUnfinishedRow from server/dist (built by the harness),
// so this tests the actual function — not a re-implementation. It binds the
// server's db module, which connects to DB_PATH (the same throwaway test DB).
const require = createRequire(import.meta.url)
const { hasUnfinishedRow } = require(
  path.join(process.cwd(), 'server/dist/lib/run-placeholders.js'),
) as {
  hasUnfinishedRow: (args: {
    resultsTable: 'ai_results' | 'http_results'; runId: string; sheetId: string;
    userId: string; placeholderColumn: string; targetRows?: number[];
  }) => boolean
}

// Regression for finalizeStatus's "completed-with-placeholders" guard
// (server/src/services/ai-runner-lifecycle.ts + lib/run-placeholders.ts
// hasUnfinishedRow). Two cases:
//
//  A. GENUINELY stuck — a target row still holds '⏳ Processing...' with NO
//     ai_results row (the row was skipped by an unexpected throw the dispatch
//     .catch swallowed). The run must NOT be marked 'completed'; it should fail
//     so the user gets a retry path and the spinner is cleared.
//
//  B. FALSE-POSITIVE GUARD — a row whose model output is LITERALLY
//     '⏳ Processing...' but which HAS an ai_results row. This is a legitimately
//     completed row; it must NOT trip the guard. The run completes and the cell
//     value is preserved (not clobbered).
//
// finalizeStatus itself runs in the worker (needs a failing OpenRouter call to
// reach), so we call its decision helper hasUnfinishedRow directly to lock in the
// collision-proof, target-aware semantics. Seeds go into the DB the server reads
// (like ai-commit-superseded.spec.ts).
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

const PLACEHOLDER = '⏳ Processing...'
const COL = 'Enrich (Output)'

// Call the real hasUnfinishedRow (full-run form: no target scoping). If true, the
// worker marks the run 'failed' instead of 'completed'.
function isStuck(runId: string, sheetId: string, userId: string): boolean {
  return hasUnfinishedRow({
    resultsTable: 'ai_results', runId, sheetId, userId, placeholderColumn: COL,
  })
}

test('finalize guard: a placeholder WITH a result row does NOT count as stuck (false-positive guard)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const db = openTestDb()
  try {
    const userId = seedUserId(db)
    const runId = randomUUID()
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, total_rows, processed_rows)
                VALUES (?, ?, ?, ?, 'p', 'running', 2, 2)`).run(runId, sheetId, userId, COL)

    const setCell = db.prepare(`UPDATE rows SET data = json_set(data, '$."Enrich (Output)"', ?) WHERE sheet_id = ? AND user_id = ? AND row_index = ?`)
    const insResult = db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status) VALUES (?, ?, ?, ?, ?, 'completed')`)

    // Row 0: a normal completed cell. Row 1: the model LEGITIMATELY output the
    // literal placeholder string — but a result row exists for it.
    setCell.run('hello', sheetId, userId, 0)
    insResult.run(randomUUID(), runId, userId, 0, 'hello')
    setCell.run(PLACEHOLDER, sheetId, userId, 1)
    insResult.run(randomUUID(), runId, userId, 1, PLACEHOLDER)

    // Both rows have results → NOT stuck → run would complete, value preserved.
    expect(isStuck(runId, sheetId, userId)).toBe(false)
  } finally {
    db.close()
    await api.dispose()
  }
})

test('finalize guard: a placeholder with NO result row counts as stuck (true positive)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const db = openTestDb()
  try {
    const userId = seedUserId(db)
    const runId = randomUUID()
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, total_rows, processed_rows)
                VALUES (?, ?, ?, ?, 'p', 'running', 2, 1)`).run(runId, sheetId, userId, COL)

    const setCell = db.prepare(`UPDATE rows SET data = json_set(data, '$."Enrich (Output)"', ?) WHERE sheet_id = ? AND user_id = ? AND row_index = ?`)
    const insResult = db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status) VALUES (?, ?, ?, ?, ?, 'completed')`)

    // Row 0 completed (cell + result). Row 1 was SKIPPED: still holds the
    // placeholder, NO result row for this run → genuinely stuck.
    setCell.run('done', sheetId, userId, 0)
    insResult.run(randomUUID(), runId, userId, 0, 'done')
    setCell.run(PLACEHOLDER, sheetId, userId, 1)

    expect(isStuck(runId, sheetId, userId)).toBe(true)
  } finally {
    db.close()
    await api.dispose()
  }
})

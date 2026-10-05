import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { authedApi, seedSheet } from './helpers'

// Regression: the AI SSE stream (server/src/routes/ai-stream.ts) must deliver
// EVERY ai_results row exactly once — including a row INSERTED MID-STREAM into a
// second the cursor has already partially walked.
//
// The bug: the tail cursor was (created_at > ? OR (created_at = ? AND id > ?))
// ORDER BY created_at ASC, id ASC. ai_results.created_at is 1-second granularity
// and id is a RANDOM uuidv4 — so within one second the cursor orders by random
// uuid. Once a tick advanced lastId to a HIGH uuid, a same-second row inserted
// LATER with a LOWER uuid was skipped forever (`id > lastId` never matched it).
// On a real run (concurrency up to 100) rows complete continuously within the
// same second, so this skipped live updates — the cell stayed '⏳ Processing...'
// until a reload. The fix cursors by rowid (monotonic insert order).
//
// To hit the REAL race (not a static backlog, which the old cursor drained fine)
// we: open the stream on a RUNNING run that has one HIGH-uuid result; let the
// first tick cursor past it; then mid-stream insert a LOW-uuid result in the SAME
// second and flip the run to completed. The old cursor skips the low-uuid row;
// rowid delivers it. We assert BOTH row indices arrive over SSE.
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

// uuid-shaped id with a controllable leading hex nibble so we can force id-sort
// order independent of insertion order. The leading nibble dominates lexicographic
// comparison, which is what the old `id > lastId` cursor used.
function idWithLead(leadNibble: string): string {
  const rest = randomUUID().slice(1) // keep canonical shape, replace first char
  return `${leadNibble}${rest}`
}

const SHARED_SECOND = '2020-01-01 00:00:00'

test('AI SSE delivers a low-uuid result inserted mid-stream into an already-cursored second (cursor-skip fix)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2) // rows 0,1
  const db = openTestDb()
  try {
    const userId = seedUserId(db)
    const COL = 'Enrich (Output)'
    const runId = randomUUID()

    // A RUNNING run (so the stream stays open and keeps polling). One initial
    // result for row 0 with a HIGH-uuid (lead 'f') at SHARED_SECOND.
    db.prepare(`
      INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, total_rows, processed_rows, created_at)
      VALUES (?, ?, ?, ?, 'p', 'running', 2, 1, '2020-01-01 00:00:00')
    `).run(runId, sheetId, userId, COL)
    db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, created_at)
      VALUES (?, ?, ?, 0, 'OUT_0', 'completed', ?)
    `).run(idWithLead('f'), runId, userId, SHARED_SECOND)

    // ~600ms after the request starts (after the immediate tick + ~1 poll), insert
    // row 1's result with a LOW-uuid (lead '0') in the SAME second — the row the
    // old cursor (now past 'f…') skips forever — then flip the run to completed so
    // the stream drains and closes. better-sqlite3 is sync; setTimeout schedules it
    // off the request's await so it lands while the stream is live.
    const insertLate = db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, created_at)
      VALUES (?, ?, ?, 1, 'OUT_1', 'completed', ?)
    `)
    const completeRun = db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?")
    const lateTimer = setTimeout(() => {
      insertLate.run(idWithLead('0'), runId, userId, SHARED_SECOND)
      completeRun.run(runId)
    }, 600)

    let received: number[]
    try {
      received = await collectStreamRowIndices(api, runId)
    } finally {
      clearTimeout(lateTimer)
    }

    const unique = new Set(received)
    // Row 0 (high uuid, present at open) always arrives. Row 1 (low uuid, inserted
    // mid-stream) is the one the old cursor skips — its presence proves the fix.
    expect(unique.has(0), 'row 0 (initial result) should be delivered').toBe(true)
    expect(unique.has(1), 'row 1 (low-uuid result inserted mid-stream) must be delivered — the cursor-skip bug drops it').toBe(true)
  } finally {
    db.close()
    await api.dispose()
  }
})

// Drive the SSE endpoint and parse the text/event-stream body, returning the row
// indices carried by 'result' events. The server ends the stream once the run is
// terminal AND drained, so the response body is finite.
async function collectStreamRowIndices(api: import('@playwright/test').APIRequestContext, runId: string): Promise<number[]> {
  const res = await api.get(`/api/ai/runs/${runId}/stream`, {
    headers: { Accept: 'text/event-stream' },
    timeout: 20_000,
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.text()
  const indices: number[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    try {
      const evt = JSON.parse(trimmed.slice('data:'.length).trim())
      if (evt.type === 'result' && typeof evt.rowIndex === 'number' && evt.columnName === 'Enrich (Output)') {
        indices.push(evt.rowIndex)
      }
    } catch { /* non-JSON keepalive */ }
  }
  return indices
}

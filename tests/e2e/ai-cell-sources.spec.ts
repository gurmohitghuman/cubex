import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

// Clicking a "(Data)" cell asks for that ONE cell's sources (GET
// /api/ai/sheets/:id/sources) instead of the grid loading every result id on
// each reload. The cell's run is the one whose "(Data)" column it is: a
// structured run's stored data_column, or a single-column search run's
// "(Output)" sibling. The newest run with sources at that row wins.

function openTestDb(): Database.Database {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
  if (/(^|\/)cubex\.db$/.test(dbPath)) throw new Error('refusing to open the real cubex.db')
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  return db
}

test('a "(Data)" cell resolves to the sources of its own run and row', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const db = openTestDb()
  try {
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id
    const insertRun = db.prepare(`
      INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status, total_rows, processed_rows,
        output_columns, status_column, data_column, use_openrouter_web_search, use_web_fetch, created_at)
      VALUES (?, ?, ?, ?, 'p', 'completed', 2, 2, ?, ?, ?, ?, ?, ?)
    `)
    const insertResult = db.prepare(`
      INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, scraped_data)
      VALUES (?, ?, ?, ?, '', 'completed', ?)
    `)
    const sources = (url: string) => JSON.stringify([{ title: url, url, content: '', snippet: '' }])
    const specs = JSON.stringify([{ columnName: 'Keep', type: 'boolean', description: 'd' }])

    // A structured fetch run (its "(Data)" column is stored) and a single-column
    // search run (its "(Data)" column is the "(Output)" sibling).
    const structured = randomUUID()
    insertRun.run(structured, sheetId, userId, 'Lead (Status)', specs, 'Lead (Status)', 'Lead (Data)', 0, 1, '2020-01-01 00:00:00')
    insertResult.run(randomUUID(), structured, userId, 0, sources('https://stripe.com'))
    const single = randomUUID()
    insertRun.run(single, sheetId, userId, 'Pitch (Output)', null, null, null, 1, 0, '2020-01-01 00:00:01')
    insertResult.run(randomUUID(), single, userId, 1, sources('https://news.io/a'))
    // A newer rerun on the structured column that only did row 1.
    const rerun = randomUUID()
    insertRun.run(rerun, sheetId, userId, 'Lead (Status)', specs, 'Lead (Status)', 'Lead (Data)', 0, 1, '2020-01-02 00:00:00')
    insertResult.run(randomUUID(), rerun, userId, 1, sources('https://linear.app'))

    const lookup = async (rowIndex: number | string, column: string, sheet = sheetId) => {
      const res = await api.get(`/api/ai/sheets/${sheet}/sources`, { params: { row_index: String(rowIndex), column } })
      return { status: res.status(), body: res.ok() ? await res.json() : null }
    }
    const firstUrl = async (rowIndex: number, column: string) => (await lookup(rowIndex, column)).body?.scrapedData?.[0]?.url

    expect(await firstUrl(0, 'Lead (Data)')).toBe('https://stripe.com')   // the rerun skipped row 0
    expect(await firstUrl(1, 'Lead (Data)')).toBe('https://linear.app')   // the newer run wins
    expect(await firstUrl(1, 'Pitch (Data)')).toBe('https://news.io/a')
    expect((await lookup(0, 'Pitch (Data)')).body.scrapedData).toBeNull() // no sources at that row
    expect((await lookup(0, 'Keep')).body.scrapedData).toBeNull()         // not a "(Data)" column
    expect((await lookup(0, 'Lead (Data)', randomUUID())).body.scrapedData).toBeNull() // another sheet
    expect((await lookup('x', 'Lead (Data)')).status).toBe(400)
    expect((await lookup(0, '')).status).toBe(400)
  } finally {
    db.close()
  }
})

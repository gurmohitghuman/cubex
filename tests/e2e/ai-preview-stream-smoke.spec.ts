import { test, expect, APIRequestContext } from '@playwright/test'
import path from 'path'
import crypto from 'node:crypto'
import { createRequire } from 'module'
import { authedApi, seedSheet } from './helpers'

// Smoke for the streaming-preview changes shipped this session. Two server-
// observable invariants from the bug-audit fixes:
//
//   #2  The preview's {type:'done'} carries runTargetRows = the UNFILTERED row
//       count "Run All Rows" will process — NOT the filter-aware sheet total. The
//       cost estimate is built from this, so if it were filtered the estimate
//       would UNDERSTATE a run while an empty-filter is active. We set an empty
//       filter, then assert runTargetRows still equals the full row count.
//
//   #1  Each {type:'row'} line carries a server-assigned previewIndex (sample
//       display order), so the client renders in the server's intended order
//       instead of the order rows finish streaming in.
//
// No real generation is billed: we seed a FAKE OpenRouter key so getOpenRouterClient
// succeeds (the route reaches the stream) but each sample row gets a 401 from
// OpenRouter — a per-row error, no tokens generated. The {done} line is emitted
// regardless, which is exactly what we assert on.

const require = createRequire(import.meta.url)

function openDb() {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(dbPath)
  db.pragma('busy_timeout = 5000')
  return db
}

function seedUserId(db: any): string {
  const row = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined
  if (!row) throw new Error('seed user not found in test DB')
  return row.id
}

// Give the account a (fake) OpenRouter key, encrypted exactly as the app stores
// it: the built server's encrypt() resolves the same key as the server (the
// harness leaves APP_ENCRYPTION_KEY empty, so both read the .encryption-key file
// generated next to the test DB). The key is intentionally invalid → 401 per
// row → no billed generation. The ciphertext is remembered so afterAll can clear
// exactly this key.
let fakeKeyCiphertext: string | null = null
function seedFakeOpenRouterKey(db: any, userId: string) {
  const { encrypt } = require(path.join(process.cwd(), 'server/dist/lib/crypto.js'))
  fakeKeyCiphertext = encrypt('sk-or-fake-e2e') as string
  const updated = db.prepare('UPDATE settings SET openrouter_api_key_encrypted = ? WHERE user_id = ?')
    .run(fakeKeyCiphertext, userId)
  if (updated.changes === 0) {
    db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?, ?, ?)')
      .run(crypto.randomUUID(), userId, fakeKeyCiphertext)
  }
}

// POST /ai/preview returns newline-delimited JSON. Collect every parsed line.
async function readPreviewStream(api: APIRequestContext, body: Record<string, unknown>) {
  const res = await api.post('/api/ai/preview', { data: body })
  expect(res.ok(), `preview HTTP ${res.status()}: ${await res.text().catch(() => '')}`).toBeTruthy()
  const text = await res.text()
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as { type: string; [k: string]: any })
}

test.describe('AI preview stream', () => {
  // The fake key above is written straight into the shared account's settings
  // row and outlives this spec — a later spec that asserts "no key configured"
  // (api-v1-runs-ai expects a run to FAIL for want of a model/key) then sees a
  // key and reads as a product bug. Clear it so specs stay order-independent.
  test.afterAll(() => {
    const db = openDb()
    try {
      if (fakeKeyCiphertext) {
        db.prepare('UPDATE settings SET openrouter_api_key_encrypted = NULL WHERE openrouter_api_key_encrypted = ?')
          .run(fakeKeyCiphertext)
      }
    } finally {
      db.close()
    }
  })

  test('done carries UNFILTERED runTargetRows even with an empty-filter active; rows carry previewIndex', async () => {
    const api = await authedApi()
    // 5 rows; we'll blank 2 of them and turn the empty-filter on so the filtered
    // count (3) differs from the true run target (5).
    const { sheetId } = await seedSheet(api, 5)

    const db = openDb()
    let userId: string
    try {
      userId = seedUserId(db)
      seedFakeOpenRouterKey(db, userId)
      // Blank two rows (indices 3,4) and switch on the empty-filter for 'val' so a
      // FILTERED read would return totalRows=3.
      db.prepare("UPDATE rows SET data = json_set(data, '$.val', '') WHERE sheet_id = ? AND row_index IN (3,4)").run(sheetId)
      db.prepare('UPDATE sheets SET empty_filter = ? WHERE id = ?')
        .run(JSON.stringify({ val: 'not_empty' }), sheetId)
    } finally {
      db.close()
    }

    // Sanity: a FILTERED sheet read now reports fewer rows than the sheet really has.
    const filtered = await (await api.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)).json()
    expect(filtered.data.totalRows).toBe(3) // empties hidden — this is what the OLD estimate used

    const lines = await readPreviewStream(api, {
      sheetId, columnName: 'out', prompt: 'echo /val',
      model: 'openai/gpt-4o-mini', previewSize: 5,
    })

    const done = lines.find(l => l.type === 'done')
    expect(done, 'stream must emit a {type:"done"} line').toBeTruthy()
    // THE FIX: run target is the UNFILTERED count (5), not the filtered total (3).
    expect(done!.runTargetRows).toBe(5)

    // Every row line carries a server-assigned previewIndex (fix #1). The fake key
    // makes each row an error row, but the line — and its previewIndex — is still sent.
    const rowLines = lines.filter(l => l.type === 'row')
    expect(rowLines.length).toBeGreaterThan(0)
    for (const r of rowLines) {
      expect(typeof r.previewIndex, `row ${r.rowIndex} missing previewIndex`).toBe('number')
    }
    // previewIndex values are a 0-based contiguous range over the sample.
    const indices = rowLines.map(r => r.previewIndex).sort((a, b) => a - b)
    expect(indices[0]).toBe(0)
    expect(indices[indices.length - 1]).toBe(rowLines.length - 1)
  })
})

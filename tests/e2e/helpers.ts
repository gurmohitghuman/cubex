import { request as pwRequest, APIRequestContext, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

// Playwright runs specs as ESM, where `require` is undefined. Recreate it so we
// can load the CJS better-sqlite3 native module for direct test-DB writes.
const require = createRequire(import.meta.url)

// Shared E2E helpers. Cookie-based auth (HttpOnly cubex_session). Cubex has a
// single account; the harness (scripts/e2e-harness.sh) sets its password to
// TEST_PASSWORD through POST /api/auth/setup before any spec runs. API base +
// client base are the same prod origin (the server serves client/dist).
export const BASE = process.env.E2E_BASE || 'http://localhost:3099'
export const TEST_PASSWORD = 'password123'

// One logged-in APIRequestContext, reused while its session stays valid. Every
// spec shares the one account serially (workers: 1); seedSheet clears its
// tables on each call.
let _api: APIRequestContext | null = null

// The session cookie is also persisted beside the throwaway test DB and
// replayed, so a fresh module (a new worker) doesn't need its own login. The
// file is torn down with the test DB.
function cookieCachePath(): string | null {
  const dbPath = process.env.DB_PATH
  return dbPath ? path.join(path.dirname(dbPath), '.e2e-session.json') : null
}

function loadCachedCookies(): Array<Record<string, unknown>> | null {
  const p = cookieCachePath()
  if (!p) return null
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as { cookies?: Array<Record<string, unknown>> }
    const cookies = raw.cookies ?? []
    // A cubex_session cookie past its expiry is useless — force a fresh login.
    const session = cookies.find(c => c.name === 'cubex_session')
    if (!session) return null
    const expires = typeof session.expires === 'number' ? session.expires : -1
    if (expires > 0 && expires * 1000 < Date.now() + 60_000) return null
    return cookies
  } catch {
    return null
  }
}

function saveCachedCookies(cookies: Array<Record<string, unknown>>): void {
  const p = cookieCachePath()
  if (!p) return
  try {
    fs.writeFileSync(p, JSON.stringify({ cookies }), { mode: 0o600 })
  } catch {
    /* best-effort — a cache miss just costs one extra login */
  }
}

// A session is only as good as the account's session_epoch: specs that sign
// out or change the password (logout-revocation, auth-single-account) revoke
// every session, this cached one included, and Playwright keeps this module
// alive across spec files in the worker. So check before handing one out.
async function stillSignedIn(ctx: APIRequestContext): Promise<boolean> {
  const res = await ctx.get('/api/auth/status')
  return res.ok() && (await res.json()).authenticated === true
}

export async function authedApi(): Promise<APIRequestContext> {
  if (_api && await stillSignedIn(_api)) return _api
  _api = null

  const cachedCookies = loadCachedCookies()
  if (cachedCookies) {
    const ctx = await pwRequest.newContext({
      baseURL: BASE,
      storageState: { cookies: cachedCookies as never, origins: [] },
    })
    if (await stillSignedIn(ctx)) {
      makeDisposeNoop(ctx)
      _api = ctx
      return ctx
    }
  }

  const ctx = await pwRequest.newContext({ baseURL: BASE })
  const res = await ctx.post('/api/auth/login', { data: { password: TEST_PASSWORD } })
  if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`)
  saveCachedCookies((await ctx.storageState()).cookies as Array<Record<string, unknown>>)
  makeDisposeNoop(ctx)
  _api = ctx
  return ctx
}

// Per-test code calls api.dispose(); since the context is shared we must NOT
// actually tear it down, or the next test loses its cookie jar. Callers keep
// calling api.dispose() (harmless no-op now). Real teardown happens at process
// exit. Override only the shared instance's dispose to a no-op.
function makeDisposeNoop(ctx: APIRequestContext) {
  ;(ctx as unknown as { dispose: () => Promise<void> }).dispose = async () => {}
}

// Create a fresh table + sheet with `rows` rows in a single 'val' column.
export async function seedSheet(api: APIRequestContext, rows: number): Promise<{ tableId: string; sheetId: string }> {
  // Start from an empty workspace: every spec shares the one account serially,
  // so clear any tables a prior test left before creating a new one.
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const tbl = await api.post('/api/tables', { data: { name: `T_${Date.now()}_${Math.random()}` } })
  const tblBody = await tbl.json()
  const tableId = tblBody.id
  const sheetId = tblBody.sheets[0].id
  // Adding the first column creates a single placeholder row at index 0, so the
  // rows exist BEFORE we PUT values. The real app works the same way: rows are
  // created via POST /rows (blank), then filled via PUT /data — upsert mode
  // writes values into existing rows, it does NOT create rows by index (that
  // would resurrect deleted rows). Seeding must mirror that or the PUT below
  // silently skips every index past 0.
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'val' } })
  if (rows > 1) {
    const add = await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: rows - 1 } })
    expect(add.ok()).toBeTruthy()
  }
  const updates = Array.from({ length: rows }, (_, i) => ({ rowIndex: i, columnName: 'val', value: `v${i}` }))
  const put = await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })
  expect(put.ok()).toBeTruthy()
  return { tableId, sheetId }
}

export async function getSheet(api: APIRequestContext, sheetId: string) {
  const res = await api.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)
  expect(res.ok()).toBeTruthy()
  return res.json()
}

// Upload a CSV the way the real client FormData does: multipart field `file`
// (the server keys on `req.file.originalname` ending in `.csv`) plus a string
// `replaceData` field. Used by the csv-import spec.
export async function importCsv(
  api: APIRequestContext,
  sheetId: string,
  csv: string,
  opts: { replaceData?: boolean; filename?: string } = {},
) {
  return api.post(`/api/sheets/${sheetId}/import`, {
    multipart: {
      file: {
        name: opts.filename ?? 'data.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csv, 'utf-8'),
      },
      replaceData: String(opts.replaceData ?? false),
    },
  })
}

// Mint an access token (PAT) for MCP / /api/v1 specs, straight into the test DB:
// no HTTP round-trips, and stale tokens are revoked first so the 10-token cap
// (MAX_ACCESS_TOKENS_PER_USER) is never reached across a full run. Same
// better-sqlite3-against-DB_PATH pattern as setSheetName below; harness-only.
//
// The token format mirrors server/src/lib/access-token.ts exactly — 'cubex_pat_'
// + 32 random bytes hex, stored as sha256(token) with a 12-char display prefix.
// If that server-side shape ever changes, this must change with it (a stale
// format shows up immediately as a 401 on every PAT-authenticated spec).
//
// Stale tokens are revoked (revoked_at set), not deleted: the partial UNIQUE
// index on (user_id, LOWER(name)) WHERE revoked_at IS NULL then frees the name.
const ACCESS_TOKEN_PREFIX = 'cubex_pat_'
const ACCESS_TOKEN_RAW_BYTES = 32
const ACCESS_TOKEN_DISPLAY_PREFIX_CHARS = 12

export function mintAccessTokenInDb(scopes: string[], name: string): string {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
  const crypto = require('node:crypto')
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    const row = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined
    if (!row) throw new Error('no account in the test DB (did the harness run setup?)')
    const userId = row.id

    // Free this name, then keep the newest few so the 10-cap is never reached.
    // (mcp-runs legitimately holds two live tokens at once — hence "newest 5",
    // not a blanket revoke.)
    db.prepare(
      `UPDATE access_tokens SET revoked_at = datetime('now')
       WHERE revoked_at IS NULL AND user_id = ? AND LOWER(name) = LOWER(?)`,
    ).run(userId, name)
    db.prepare(`
      UPDATE access_tokens SET revoked_at = datetime('now')
      WHERE revoked_at IS NULL AND user_id = ? AND id IN (
        SELECT id FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT -1 OFFSET 5
      )
    `).run(userId, userId)

    const token = ACCESS_TOKEN_PREFIX + crypto.randomBytes(ACCESS_TOKEN_RAW_BYTES).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    db.prepare(`
      INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(
      crypto.randomUUID(), userId, name, tokenHash,
      token.slice(0, ACCESS_TOKEN_DISPLAY_PREFIX_CHARS), scopes.join(','),
    )
    return token
  } finally {
    db.close()
  }
}

// `api` is unused (there is one account) but kept so call sites read naturally.
export async function makeAccessToken(
  _api: APIRequestContext, scopes: string[], name: string,
): Promise<string> {
  return mintAccessTokenInDb(scopes, name)
}

// Set sheets.name directly in the throwaway test DB. There is NO API route that
// renames a sheet (names are hard-coded 'Sheet1' at create time in tables.ts),
// so the only way an injection-bearing name reaches the export endpoint is a
// direct write — which is exactly the threat contentDispositionFilename defends
// against. A second better-sqlite3 connection against DB_PATH, WAL-safe with a
// busy_timeout.
export function setSheetName(sheetId: string, name: string) {
  const dbPath = process.env.DB_PATH
  if (!dbPath) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(dbPath)
  try {
    db.pragma('busy_timeout = 5000')
    db.prepare('UPDATE sheets SET name = ? WHERE id = ?').run(name, sheetId)
  } finally {
    db.close()
  }
}

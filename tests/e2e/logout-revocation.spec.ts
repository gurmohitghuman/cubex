import { test, expect, request as pwRequest } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { TEST_PASSWORD } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// E2E coverage for POST /api/auth/logout — specifically that logout BUMPS the
// account's session_epoch so a cookie captured before logout is centrally
// revoked, not merely cleared from the caller's browser. Without the bump, a
// copied cookie would stay valid until the JWT's natural expiry. The epoch is
// per-account, so this is "log out everywhere".
//
// We log in through the real API to mint a genuine JWT cookie, snapshot that
// cookie as the "stolen" one, log out, then replay the stolen cookie against an
// authed route — it must now 401 because authenticateUser rejects the stale epoch.
// (Other specs' cached sessions die too; helpers.authedApi re-logs in.)
const BASE = process.env.E2E_BASE || 'http://localhost:3099'

// Reach the same throwaway DB the harness booted the server on (separate process,
// shared on-disk SQLite in WAL mode).
const DB_PATH = process.env.DB_PATH
if (!DB_PATH) throw new Error('DB_PATH not set — run via scripts/e2e-harness.sh')
if (/(^|\/)cubex\.db$/.test(DB_PATH)) throw new Error('refusing to touch the real cubex.db')

const Database = require(path.resolve(__dirname, '../../node_modules/better-sqlite3'))

function sessionEpoch(): number {
  const db = new Database(DB_PATH)
  try {
    db.pragma('busy_timeout = 5000')
    const r = db.prepare('SELECT session_epoch FROM users LIMIT 1').get() as { session_epoch: number } | undefined
    if (!r) throw new Error('no account in the test DB')
    return r.session_epoch
  } finally {
    db.close()
  }
}

const api = () => pwRequest.newContext({ baseURL: BASE })

test.describe('POST /api/auth/logout', () => {
  test('logout bumps session_epoch and revokes the pre-logout cookie', async () => {
    // Log in. Playwright's context keeps the cookie jar; capture the Set-Cookie
    // so we can replay it as a "stolen" cookie after logout (the jar itself gets
    // cleared by logout's clearSessionCookie, so we can't rely on it for replay).
    const ctx = await api()
    const login = await ctx.post('/api/auth/login', { data: { password: TEST_PASSWORD } })
    expect(login.status()).toBe(200)
    const stolen = (login.headers()['set-cookie'] || '').split(';')[0] // "cubex_session=<jwt>"
    expect(stolen).toMatch(/^cubex_session=.+/)

    // Authed request with the live session works.
    expect((await ctx.get('/api/tables')).status()).toBe(200)

    const before = sessionEpoch()
    const logout = await ctx.post('/api/auth/logout')
    expect(logout.status()).toBe(200)
    expect(sessionEpoch()).toBe(before + 1)

    // Replay the stolen pre-logout cookie from a FRESH context (no jar carryover)
    // against an authed route — must be rejected now that the epoch moved.
    const attacker = await api()
    const replay = await attacker.get('/api/tables', { headers: { cookie: stolen } })
    expect(replay.status()).toBe(401)

    await attacker.dispose()
    await ctx.dispose()
  })

  test('logout with no/stale cookie still 200s (clean logout, nothing to revoke)', async () => {
    // A browser whose cookie already expired (or never had one) must still get a
    // clean 200 from logout, NOT a 401 — the handler authenticates non-rejecting.
    const ctx = await api()
    const res = await ctx.post('/api/auth/logout')
    expect(res.status()).toBe(200)
    await ctx.dispose()
  })

  test('a bogus/garbage cookie does not bump the epoch and logout still 200s', async () => {
    const before = sessionEpoch()
    const ctx = await api()
    const res = await ctx.post('/api/auth/logout', {
      headers: { cookie: 'cubex_session=not-a-real-jwt' },
    })
    expect(res.status()).toBe(200)
    // An unverifiable token resolves to no user, so the epoch doesn't move.
    expect(sessionEpoch()).toBe(before)
    await ctx.dispose()
  })
})

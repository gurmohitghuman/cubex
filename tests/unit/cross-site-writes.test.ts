// Cookie-session writes from another site's page are refused (lib/cross-site.ts, middleware/auth.ts): SameSite
// ignores ports, so a page of another app on the same host sends Cubex's session cookie. With a real session
// cookie, through authenticateToken: a write whose Sec-Fetch-Site is same-site or cross-site gets 403 (before the
// session is read: no cookie gets 403 too), whatever its method; same-origin (Cubex's own pages), none (the
// address typed) and no header (curl, scripts) go through; reads always do. Without Sec-Fetch-Site (plain HTTP to
// an address other than localhost), the Origin must be the server's own address or PUBLIC_URL's. The auth routes
// refuse the same.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import authLibMod from '../../server/src/lib/auth'
import authMod from '../../server/src/middleware/auth'
import routeMod from '../../server/src/routes/auth'
import crossMod from '../../server/src/lib/cross-site'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { signToken } = authLibMod as typeof import('../../server/src/lib/auth')
const { authenticateToken } = authMod as typeof import('../../server/src/middleware/auth')
const authRoutes = (routeMod as unknown as { default: express.Router }).default
const { crossSiteWrite } = crossMod as typeof import('../../server/src/lib/cross-site')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`

const app = express()
app.use(cookieParser())
app.use('/api/auth', authRoutes)
app.all('/w', authenticateToken, (_req, res) => { res.json({ ok: true }) })
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const send = async (method: string, path: string, site?: string, withCookie = true, origin?: string) => {
  const res = await fetch(`${base}${path}`, { method, headers: {
    ...(withCookie ? { cookie } : {}), ...(site ? { 'sec-fetch-site': site } : {}), 'content-type': 'application/json',
    ...(origin ? { origin } : {}),
  }, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' })
  return { status: res.status, body: method === 'HEAD' ? null : await res.json() }
}
const refused = { status: 403, body: { error: 'Cross-site request refused' } }

let failures = 0
async function check(label: string, fn: () => Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

try {
  await check('a write from another site\'s page (same-site, cross-site) is refused, whatever its method', async () => {
    for (const site of ['same-site', 'cross-site']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.deepEqual(await send(method, '/w', site), refused, `${method} ${site}`)
      }
    }
  })
  await check('... before the session is read: without a cookie, 403 too (not 401)', async () => {
    assert.deepEqual(await send('POST', '/w', 'same-site', false), refused)
  })
  await check('Cubex\'s own pages, a typed address and non-browser clients write as before', async () => {
    for (const site of ['same-origin', 'none', undefined]) {
      assert.deepEqual(await send('POST', '/w', site), { status: 200, body: { ok: true } }, String(site))
    }
  })
  await check('reads from another site go through (another origin can\'t read the answer)', async () => {
    assert.deepEqual(await send('GET', '/w', 'same-site'), { status: 200, body: { ok: true } })
  })
  // Over plain HTTP to an address other than localhost (a LAN install) browsers send no Sec-Fetch-Site: there the
  // Origin decides. The test server is at 127.0.0.1:<port>, so that is its own address.
  const port = new URL(base).port
  await check('no Sec-Fetch-Site: a write from another port on the same host is refused, by its Origin', async () => {
    for (const origin of [`http://127.0.0.1:${Number(port) + 1}`, 'http://127.0.0.1', 'null', '']) {
      assert.deepEqual(await send('POST', '/w', undefined, true, origin || ' '), refused, origin)
    }
    assert.deepEqual(await send('POST', '/api/auth/logout', undefined, true, 'null'), refused)
  })
  await check('... and one from its own address goes through', async () => {
    assert.deepEqual(await send('POST', '/w', undefined, true, base), { status: 200, body: { ok: true } })
  })
  await check('the Origin is compared as an address: case, default port, IPv6, PUBLIC_URL', async () => {
    const req = (headers: Record<string, string>, method = 'POST') =>
      ({ method, get: (h: string) => headers[h.toLowerCase()] }) as unknown as express.Request
    const allowed = (origin: string, host?: string) => !crossSiteWrite(req({ origin, ...(host ? { host } : {}) }))
    assert.equal(allowed('http://myhost:3002', 'MyHost:3002'), true)
    assert.equal(allowed('http://myhost', 'myhost:80'), true)
    assert.equal(allowed('https://myhost', 'myhost:443'), true)
    assert.equal(allowed('http://[::1]:3002', '[0:0:0:0:0:0:0:1]:3002'), true)
    assert.equal(allowed('http://myhost:8080', 'myhost:3002'), false)
    assert.equal(allowed('http://myhost.evil:3002', 'myhost:3002'), false)
    assert.equal(allowed('chrome-extension://myhost:3002', 'myhost:3002'), false)
    assert.equal(allowed('http://myhost:3002'), false, 'no Host')
    // A proxy over plain HTTP that sends its own Host: PUBLIC_URL names the address people open.
    assert.equal(allowed('http://cubex.lan', '127.0.0.1:3002'), false)
    process.env.PUBLIC_URL = 'http://cubex.lan/'
    try {
      assert.equal(allowed('http://cubex.lan', '127.0.0.1:3002'), true)
      assert.equal(allowed('http://cubex.lan:8080', '127.0.0.1:3002'), false)
    } finally { delete process.env.PUBLIC_URL }
    // Sec-Fetch-Site, when there, decides alone; reads are never refused.
    assert.equal(!crossSiteWrite(req({ 'sec-fetch-site': 'same-origin', origin: 'http://other:1', host: 'h' })), true)
    assert.equal(!crossSiteWrite(req({ 'sec-fetch-site': 'same-site', origin: 'http://h', host: 'h' })), false)
    assert.equal(!crossSiteWrite(req({ origin: 'null', host: 'h' }, 'GET')), true)
  })
  await check('the auth routes refuse the same', async () => {
    assert.deepEqual(await send('POST', '/api/auth/logout', 'same-site'), refused)
    assert.equal((await send('POST', '/api/auth/logout', 'same-origin')).status, 200)
  })
} finally {
  server.close()
}

if (failures > 0) { console.error(`${failures} cross-site-writes check(s) failed`); process.exit(1) }
console.log('cross-site-writes: all assertions passed')

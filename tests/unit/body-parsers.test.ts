// Over 200 lines: one server through the real chain, each check another way a body arrives.
// Request bodies, through index.ts's middleware and the real routes on a real socket. The app's own parsers
// (lib/session-body.ts) read a body only for a signed-in session: without one, a body declaring 32 MB gets 401
// at once with nothing read, and a compressed one is never inflated. Signed in, a compressed body gets 415, one
// over 32 MB 413 and bad JSON 400, none of them logged; a 1 MB autosave is written. Every parser that inflates
// stops at its own cap, counted in inflated bytes (413): sign-in at 4 KB, a webhook at 512 KB, /api/v1 and
// /mcp at 2 MB. zlib's inflaters are wrapped to count what they put out.
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import net from 'node:net'

// body-parser makes its inflaters through these at call time: each one made, and the bytes it put out.
const zlib = createRequire(import.meta.url)('node:zlib') as typeof import('node:zlib')
const inflated: number[] = []
for (const name of ['createGunzip', 'createInflate'] as const) {
  const real = zlib[name]
  Object.defineProperty(zlib, name, { value: (o?: import('node:zlib').ZlibOptions) => {
    const z = real(o)
    const at = inflated.push(0) - 1
    z.on('data', (c: Buffer) => { inflated[at] += c.length })
    return z
  } })
}

// Long, so a body read until its deadline shows; read when the modules load, so before the imports below.
process.env.REQUEST_BODY_TIMEOUT_MS = '5000'
const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { signToken } = await import('../../server/src/lib/auth')
const { generateAccessToken } = await import('../../server/src/lib/access-token')
const { createSourceWithColumn } = await import('../../server/src/lib/webhook-service')
const { WEBHOOK_MAX_BODY_BYTES } = await import('../../server/src/lib/constants')
const { API_V1_MAX_JSON_BYTES } = await import('../../server/src/lib/api-v1-constants')
const { applyServerMiddleware } = await import('../../server/src/lib/server-middleware')
const { requestDeadline } = await import('../../server/src/lib/request-deadline')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
// What the server logs: a body refused must leave nothing (index.ts logs a stack for an error that reaches it).
const logged: string[] = []
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
console.warn = console.error

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Name']))
const insertRow = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
db.transaction(() => { for (let i = 0; i < 2000; i++) insertRow.run(uuid(), sid, uid, i, '{}') }).immediate()
const pat = generateAccessToken()
db.prepare('INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes) VALUES (?,?,?,?,?,?)')
  .run(uuid(), uid, 'agent', pat.tokenHash, pat.tokenPrefix, 'read,write')
const webhook = createSourceWithColumn(sid, uid, 'Leads').secret

// As index.ts: the deadline first, then the global middleware and parsers, then the routes.
const app = express()
app.use(requestDeadline)
applyServerMiddleware(app, { isProduction: false })
app.use('/api/webhooks', (await import('../../server/src/routes/webhooks-public')).default)
app.use('/api/v1', (await import('../../server/src/routes/api-v1')).default)
app.use('/mcp', (await import('../../server/src/routes/mcp')).default)
app.use('/api/auth', (await import('../../server/src/routes/auth')).default)
app.use('/api/tables', (await import('../../server/src/routes/tables')).default)
app.use('/api/sheets', (await import('../../server/src/routes/sheets')).default)
app.use(['/api', '/mcp'], (_req, res) => { res.status(404).json({ error: 'Not found' }) })
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = (server.address() as AddressInfo).port
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`

// A request on a raw socket: its headers, then `body` unless `declare` (headers only, declaring that many bytes).
// status: the answer's (0 if none); ms: until the answer came, or the server hung up (the test gives up at 8 s).
type Answer = { status: number; ms: number; head: string; body: string }
function send(method: string, path: string, headers: Record<string, string>, body: Buffer,
  o: { declare?: number } = {}): Promise<Answer> {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1')
    let text = ''
    const started = Date.now()
    const done = () => {
      clearTimeout(giveUp)
      const cut = text.indexOf('\r\n\r\n')
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), ms: Date.now() - started,
        head: text.slice(0, cut), body: cut < 0 ? '' : text.slice(cut + 4) })
      sock.destroy()
    }
    const giveUp = setTimeout(done, 8000)
    sock.on('data', d => {
      text += d.toString()
      const cut = text.indexOf('\r\n\r\n')
      const length = Number(/content-length: (\d+)/i.exec(text.slice(0, cut))?.[1] ?? -1)
      if (cut >= 0 && Buffer.byteLength(text.slice(cut + 4)) >= length) done()
    })
    sock.on('error', () => {})
    sock.on('close', done)
    sock.write([`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1', `Content-Length: ${o.declare ?? body.length}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n')
    if (o.declare === undefined) sock.write(body)
  })
}
const json = { 'Content-Type': 'application/json' }
// The answer's JSON error, or null when it isn't JSON.
const errorOf = (a: Answer) => { try { return JSON.parse(a.body).error as string } catch { return null } }
const gzip = { ...json, 'Content-Encoding': 'gzip' }
const signed = { ...json, Cookie: cookie }
// A gzip body of n zero bytes: about 1/1000 of n.
const bomb = (n: number) => zlib.gzipSync(Buffer.alloc(n), { level: 9 })
// The inflaters made while `f` ran, and what each put out.
async function inflating<T>(f: () => Promise<T>): Promise<{ answer: T; made: number[] }> {
  const from = inflated.length
  const answer = await f()
  await new Promise(r => setTimeout(r, 50))
  return { answer, made: inflated.slice(from) }
}

// Without a session, the app's parsers read nothing.
{
  const big = await send('POST', '/api/tables', json, Buffer.alloc(0), { declare: 32 * 1024 * 1024 })
  check('no session, a body declaring 32 MB, only its headers sent: 401 at once, its body not waited for',
    big.status === 401 && big.ms < 1000, { status: big.status, ms: big.ms })
  const slow = await send('PUT', `/api/sheets/${sid}/data`, json, Buffer.alloc(0), { declare: 1024 })
  check('no session, an autosave declaring a body it never sends: 401 at once', slow.status === 401
    && slow.ms < 1000, { status: slow.status, ms: slow.ms })
  const z = await inflating(() => send('POST', '/api/tables', gzip, bomb(32 * 1024 * 1024)))
  check('no session, a gzip body of 32 MB inflated: 401, nothing inflated', z.answer.status === 401
    && z.made.length === 0, { status: z.answer.status, made: z.made })
  const nowhere = await inflating(() => send('POST', '/api/no-such-path', gzip, bomb(8 * 1024 * 1024)))
  check('no session, an unknown path: 404, nothing inflated', nowhere.answer.status === 404
    && nowhere.made.length === 0, { status: nowhere.answer.status, made: nowhere.made })
  const stale = `cubex_session=${signToken({ userId: uid, sessionEpoch: -1 })}x`
  const bad = await send('POST', '/api/tables', { ...json, Cookie: stale }, Buffer.alloc(0), { declare: 1 << 20 })
  check('a session cookie that doesn\'t check out: 401 at once', bad.status === 401 && bad.ms < 1000,
    { status: bad.status, ms: bad.ms })
}

// Signed in: bodies as before, a compressed one refused, errors answered without a stack.
{
  const value = 'v'.repeat(500)
  const updates = Array.from({ length: 2000 }, (_, rowIndex) => ({ rowIndex, columnName: 'Name', value }))
  const body = Buffer.from(JSON.stringify({ updates }))
  const save = await send('PUT', `/api/sheets/${sid}/data`, signed, body)
  const written = db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ? AND json_extract(data, '$.Name') = ?`)
    .pluck().get(sid, value)
  check(`signed in, a ${(body.length / 1e6).toFixed(1)} MB autosave: written`, save.status === 200
    && written === 2000, { status: save.status, written, body: save.body.slice(0, 200) })
  const made = await inflating(() => send('POST', '/api/tables', { ...gzip, Cookie: cookie },
    zlib.gzipSync(JSON.stringify({ name: 'Zipped' }))))
  check('signed in, a gzip JSON body: 415, nothing inflated, uncompressed asked for', made.answer.status === 415
    && made.made.length === 0 && /accept-encoding: identity/i.test(made.answer.head),
  { status: made.answer.status, made: made.made, head: made.answer.head })
  const deflated = await inflating(() => send('POST', '/api/tables', { ...signed, 'Content-Encoding': 'deflate' },
    zlib.deflateSync(JSON.stringify({ name: 'Zipped' }))))
  check('signed in, a deflate body: 415, nothing inflated', deflated.answer.status === 415
    && deflated.made.length === 0, { status: deflated.answer.status, made: deflated.made })
  const form = await send('POST', '/api/tables', { 'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Encoding': 'gzip', Cookie: cookie }, zlib.gzipSync('name=Zipped'))
  check('signed in, a gzip form: 415', form.status === 415 && errorOf(form) === 'Send the request body uncompressed',
    { status: form.status, body: form.body })
  const over = await send('POST', '/api/tables', signed, Buffer.alloc(32 * 1024 * 1024 + 1, 32))
  check('signed in, a body over 32 MB: 413', over.status === 413
    && errorOf(over) === 'Request body too large', { status: over.status, body: over.body })
  const broken = await send('POST', '/api/tables', signed, Buffer.from('{"name": '))
  check('signed in, bad JSON: 400', broken.status === 400 && errorOf(broken) === 'Invalid request body',
    { status: broken.status, body: broken.body })
  const latin = await send('POST', '/api/tables', { ...signed, 'Content-Type': 'application/json; charset=latin1' },
    Buffer.from('{"name":"x"}'))
  check('signed in, a charset that isn\'t UTF: 415', latin.status === 415
    && errorOf(latin) === 'Send the request body as UTF-8', { status: latin.status, body: latin.body })
  const tables = db.prepare("SELECT count(*) FROM tables WHERE user_id = ? AND name = 'Zipped'").pluck().get(uid)
  check('none of the refused bodies made a table', tables === 0, tables)
}

// Every parser that inflates stops at its own cap, counted in inflated bytes: 413 long before all of it.
{
  const FULL = 64 * 1024 * 1024
  const body = bomb(FULL)
  const capped = async (label: string, cap: number, method: string, path: string, headers: Record<string, string>) => {
    const r = await inflating(() => send(method, path, headers, body))
    const out = r.made.reduce((a, b) => a + b, 0)
    check(`${label}: a gzip body of 64 MB inflated stops at its ${cap / 1024} KB cap (413, ${Math.round(out / 1024)
    } KB inflated)`, r.answer.status === 413
      && r.made.length === 1 && out > cap && out <= cap + 256 * 1024,
    { status: r.answer.status, made: r.made, compressed: body.length })
  }
  await capped('sign-in, no account', 4 * 1024, 'POST', '/api/auth/login', gzip)
  await capped('a webhook, its token checked', WEBHOOK_MAX_BODY_BYTES, 'POST', `/api/webhooks/${webhook}`, gzip)
  const bearer = { ...gzip, Authorization: `Bearer ${pat.token}` }
  await capped('/api/v1, its token checked', API_V1_MAX_JSON_BYTES, 'POST', '/api/v1/tables', bearer)
  await capped('/mcp, its token checked', API_V1_MAX_JSON_BYTES, 'POST', '/mcp',
    { ...bearer, Accept: 'application/json, text/event-stream' })
  const login = await send('POST', '/api/auth/login', gzip, zlib.gzipSync(JSON.stringify({ password: 'p' })))
  check('sign-in still takes a small gzip body (inflated, read as JSON)', login.status === 401, login.status)
}

check('nothing logged for any refused body', logged.length === 0, logged.slice(0, 3))
check('the server answers normally after it all', (await fetch(`http://127.0.0.1:${port}/api/tables`,
  { headers: { Cookie: cookie } })).status === 200)

server.close()
server.closeAllConnections()
if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall body parser checks passed')

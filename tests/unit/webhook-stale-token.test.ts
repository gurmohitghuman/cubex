// A webhook URL stops working the moment it is rotated or turned off, even for a delivery that had already
// passed the token check (routes/webhooks-public.ts) and was still sending its body. Through the real routes:
// a request sends its headers and holds its body, the owner rotates (or turns off) the webhook, then the body
// arrives: 404, no row, no delivery, the counters and the new URL's reveal copy as they were; the new URL (or
// the webhook turned on again) still adds rows. A body still not in WEBHOOK_BODY_TIMEOUT_MS after the headers
// gets 408 and adds nothing, even when it trickles in; a large body sent at once is in time. On the append
// itself (lib/webhook-ingest.ts): a stale token hash, a webhook turned off or one deleted, or no token hash at
// all, is refused inside its transaction, and "Add again" (a replay) still works while the webhook is off.
import type { AddressInfo } from 'node:net'
import net from 'node:net'

// Short, so a held body runs out in the test (read when constants.ts loads, so before the imports below).
process.env.WEBHOOK_BODY_TIMEOUT_MS = '1500'
const express = (await import('express')).default
const cookieParser = (await import('cookie-parser')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { signToken } = await import('../../server/src/lib/auth')
const { createSourceWithColumn, sha256Hex } = await import('../../server/src/lib/webhook-service')
const { appendWebhookDelivery } = await import('../../server/src/lib/webhook-ingest')
const { applyServerTimeouts } = await import('../../server/src/lib/server-timeouts')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify([]))
const created = createSourceWithColumn(sid, uid, 'Leads')
const src = created.source.id
let secret = created.secret

// The moment a delivery is past the token check: the route prepares its token lookup, and the rest of the
// check (the bucket, the Idempotency-Key, the body parser starting to read) runs in the same tick.
const waiters: Array<() => void> = []
const prepare = db.prepare.bind(db)
db.prepare = ((sql: string) => {
  if (sql.includes('FROM webhook_sources ws WHERE token_hash')) waiters.shift()?.()
  return prepare(sql)
}) as typeof db.prepare

const publicRoutes = (await import('../../server/src/routes/webhooks-public')).default
const ownerRoutes = (await import('../../server/src/routes/sheets-webhooks')).default
const app = express()
app.use('/api/webhooks', publicRoutes)
app.use(cookieParser())
app.use(express.json())
app.use('/api/sheets', ownerRoutes)
const server = app.listen(0, '127.0.0.1')
applyServerTimeouts(server)
await new Promise(r => server.once('listening', r))
const port = (server.address() as AddressInfo).port
const base = `http://127.0.0.1:${port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`

const rows = () => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const deliveries = () => db.prepare('SELECT count(*) FROM webhook_deliveries WHERE source_id = ?')
  .pluck().get(src) as number
const stored = () => db.prepare('SELECT total_received, last_received_at, token_ciphertext, token_hash FROM '
  + 'webhook_sources WHERE id = ?').get(src) as Record<string, unknown>
const owner = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/api/sheets/${sid}/webhook${path}`, {
    method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() as { source: { url: string | null } } }
}
const post = async (token: string, body: unknown) => (await fetch(`${base}/api/webhooks/${token}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).status

// A delivery that sends its headers, waits until the route has checked its token, and sends its body on cue.
// answer: its status (0 if the server hung up without one), and when it came.
async function held(token: string, body: string) {
  const sock = net.connect(port, '127.0.0.1')
  let text = ''
  const answer = new Promise<{ status: number; at: number }>(resolve => {
    sock.on('data', d => { text += d.toString() })
    sock.on('close', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), at: Date.now() }))
    sock.on('error', () => {})
  })
  const checked = new Promise<void>(resolve => waiters.push(resolve))
  const started = Date.now()
  sock.write(`POST /api/webhooks/${token} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`)
  await checked
  return { sock, answer, started, send: (part = body) => sock.write(part) }
}
// An answer, or { status: -1 } when none comes within ms.
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<{ status: number; at: number }>(r => setTimeout(() => r({ status: -1, at: 0 }), ms))])

// Rotated while a delivery's body was on its way.
{
  const before = { rows: rows(), deliveries: deliveries() }
  const d = await held(secret, '{"mail":"a@x.com"}')
  const rotated = await owner('POST', '/rotate')
  const after = stored()
  d.send()
  const { status } = await within(d.answer, 5000)
  check('rotated while its body was on its way: the old URL\'s delivery gets 404', status === 404, { status })
  check('... and adds no row and no delivery', rows() === before.rows && deliveries() === before.deliveries,
    { rows: rows(), deliveries: deliveries() })
  const now = stored()
  check('... and leaves the counters and the new URL\'s reveal copy as the rotate left them',
    now.total_received === after.total_received && now.last_received_at === after.last_received_at
    && now.token_ciphertext === after.token_ciphertext && now.token_ciphertext !== null, { after, now })
  secret = rotated.body.source.url!.split('/api/webhooks/')[1]
  check('the new URL adds rows', await post(secret, { mail: 'b@x.com' }) === 202 && rows() === before.rows + 1)
}

// Turned off while a delivery's body was on its way.
{
  const before = { rows: rows(), deliveries: deliveries(), received: stored().total_received }
  const d = await held(secret, '{"mail":"c@x.com"}')
  check('turned off', (await owner('PATCH', '', { enabled: false })).status === 200)
  d.send()
  const { status } = await within(d.answer, 5000)
  check('turned off while its body was on its way: 404', status === 404, { status })
  check('... and nothing added or counted', rows() === before.rows && deliveries() === before.deliveries
    && stored().total_received === before.received, { rows: rows(), received: stored().total_received })
  await owner('PATCH', '', { enabled: true })
  check('turned on again, the URL adds rows', await post(secret, { mail: 'd@x.com' }) === 202
    && rows() === before.rows + 1)
}

// A body that doesn't come, or trickles: 408 at the deadline, counted from the headers.
{
  const before = rows()
  const silent = await held(secret, '{"mail":"e@x.com"}')
  const quiet = await within(silent.answer, 5000)
  const waited = quiet.at - silent.started
  check('a body that never comes: 408 about 1.5 s after the headers', quiet.status === 408 && waited >= 1400
    && waited < 3000, { status: quiet.status, waited })
  const body = '{"mail":"f@x.com","pad":"' + 'x'.repeat(40) + '"}'
  const slow = await held(secret, body)
  let at = 0
  const drip = setInterval(() => { if (at < body.length) slow.send(body[at++]) }, 100)
  const trickle = await within(slow.answer, 8000)
  clearInterval(drip)
  const took = trickle.at - slow.started
  check('a body trickling in a byte at a time: still 408 at the deadline (the bytes don\'t extend it)',
    trickle.status === 408 && took >= 1400 && took < 3000, { status: trickle.status, took, sent: at })
  check('... and neither adds a row', rows() === before, { rows: rows() })
  const big = JSON.stringify({ mail: 'g@x.com', note: 'y'.repeat(500 * 1024) })
  check('a large body (500 KB) sent at once is in time', await post(secret, JSON.parse(big)) === 202
    && rows() === before + 1)
}

// On the append itself.
{
  const source = db.prepare('SELECT id, user_id, sheet_id, enabled, raw_column_name, store_raw_mode, total_received '
    + 'FROM webhook_sources WHERE id = ?').get(src) as Parameters<typeof appendWebhookDelivery>[0]
  const hash = sha256Hex(secret)
  const send = (opts: Parameters<typeof appendWebhookDelivery>[4]) =>
    appendWebhookDelivery(source, [], { a: 1 }, '{"a":1}', opts)
  const before = rows()
  db.prepare("UPDATE webhook_sources SET token_hash = 'rotated' WHERE id = ?").run(src)
  check('the append refuses a token hash the webhook no longer has', JSON.stringify(send({ tokenHash: hash }))
    === '{"ok":false,"code":404,"reason":"Not found"}' && rows() === before)
  db.prepare('UPDATE webhook_sources SET token_hash = ?, enabled = 0 WHERE id = ?').run(hash, src)
  check('... and a webhook turned off', !send({ tokenHash: hash }).ok && rows() === before)
  db.prepare('UPDATE webhook_sources SET enabled = 1 WHERE id = ?').run(src)
  check('... and an arrival that doesn\'t say which token it was checked with', !send({}).ok && rows() === before)
  db.prepare('UPDATE webhook_sources SET enabled = 0 WHERE id = ?').run(src)
  const replay = send({ replayOf: 'a-logged-delivery' })
  check('"Add again" still works while the webhook is off (a replay is not an arrival)', replay.ok
    && rows() === before + 1, replay)
  db.prepare('DELETE FROM webhook_sources WHERE id = ?').run(src)
  let gone: unknown
  try { gone = send({ tokenHash: hash }) } catch (e) { gone = String(e) }
  check('... and a webhook deleted meanwhile gets the same 404 (it used to fail on a foreign key)',
    JSON.stringify(gone) === '{"ok":false,"code":404,"reason":"Not found"}', gone)
}

server.close()
server.closeAllConnections()
if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall webhook stale-token checks passed')

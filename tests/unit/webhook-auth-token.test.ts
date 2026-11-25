// A sheet webhook's optional token, through the real routes (routes/webhooks-public.ts, the app's
// routes/sheets-webhooks.ts, services/sheet-webhook.ts): with one set, an event must send it as
// Authorization: Bearer <token>. Without it, with a wrong one or another scheme: the generic 404, no row, and
// the rate bucket untouched (25 refused events, then one with the token, is 202). Only its hash is kept, and
// the app never reads it back. A new token stops the old one at once, even for an event already past the
// check whose body was still coming; removing it opens the URL again. And the cap on events arriving at once
// (lib/webhook-bucket.ts holdWebhookBody): with WEBHOOK_MAX_OPEN_BODIES bodies still coming, the next event gets
// 429 even with the bucket full, and spends none of it; the held ones still add their rows, and a sender that
// hangs up frees its place.
import type { AddressInfo } from 'node:net'
import net from 'node:net'
const express = (await import('express')).default
const cookieParser = (await import('cookie-parser')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { signToken } = await import('../../server/src/lib/auth')
const { createSourceWithColumn, sha256Hex } = await import('../../server/src/lib/webhook-service')
const { openWebhookBodies } = await import('../../server/src/lib/webhook-bucket')
const { WEBHOOK_MAX_OPEN_BODIES } = await import('../../server/src/lib/constants')

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
const { source, secret } = createSourceWithColumn(sid, uid, 'Leads')
const src = source.id

const app = express()
app.use('/api/webhooks', (await import('../../server/src/routes/webhooks-public')).default)
app.use(cookieParser())
app.use(express.json())
app.use('/api/sheets', (await import('../../server/src/routes/sheets-webhooks')).default)
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = (server.address() as AddressInfo).port
const base = `http://127.0.0.1:${port}`
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`

const rows = () => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const kept = () => db.prepare('SELECT auth_token_hash FROM webhook_sources WHERE id = ?').pluck().get(src) as
  string | null
const owner = async (method: string, path: string) => {
  const res = await fetch(`${base}/api/sheets/${sid}/webhook${path}`, { method, headers: { cookie } })
  return { status: res.status, text: await res.text() }
}
const send = async (auth?: string, body: unknown = { mail: 'a@x.com' }) =>
  (await fetch(`${base}/api/webhooks/${secret}`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
})).status
// Waits (a few ms at most) until n events are past the checks with their bodies still coming.
async function arriving(n: number) {
  for (let i = 0; i < 500 && openWebhookBodies(src) !== n; i++) await new Promise(r => setTimeout(r, 2))
  return openWebhookBodies(src)
}
// An event that sends its headers and holds its body until send() is called.
function held(auth?: string) {
  const body = '{"mail":"held@x.com"}'
  const sock = net.connect(port, '127.0.0.1')
  let text = ''
  const answer = new Promise<number>(resolve => {
    sock.on('data', d => { text += d.toString() })
    sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)))
    sock.on('error', () => {})
  })
  sock.write(`POST /api/webhooks/${secret} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n`
    + (auth ? `Authorization: ${auth}\r\n` : '') + `Connection: close\r\nContent-Length: ${body.length}\r\n\r\n`)
  return { answer, send: () => sock.write(body), hangUp: () => sock.destroy() }
}

check('no token: an event adds its row', await send() === 202 && rows() === 1)

const made = await owner('POST', '/token')
const { source: view, token } = JSON.parse(made.text) as { source: Record<string, unknown>; token: string }
check('the app makes a token, shown in its answer', made.status === 200 && /^[\w-]{43}$/.test(token), made)
check('... the source says one is needed, and never shows the token or its hash',
  view.tokenRequired === true && !JSON.stringify(view).includes(token) && !JSON.stringify(view).includes(kept()!))
check('only its sha256 is kept', kept() === sha256Hex(token))
const reread = await owner('GET', '')
check('reading the webhook again never shows the token or its hash',
  reread.text.includes('"tokenRequired":true') && !reread.text.includes(token) && !reread.text.includes(kept()!))

const before = rows()
const refused = [await send(), await send(`Bearer ${'x'.repeat(43)}`), await send(`Basic ${token}`),
  await send(token), await send(`Bearer ${token}x`)]
check('without it, wrong, another scheme or no scheme: the generic 404, no row',
  refused.every(s => s === 404) && rows() === before, refused)
for (let i = 0; i < 20; i++) await send()
check('refused events don\'t use up the rate bucket: 25 refused, then one with the token is 202',
  await send(`Bearer ${token}`) === 202 && rows() === before + 1)
check('the scheme is case-insensitive', await send(`bearer ${token}`) === 202)

const next = JSON.parse((await owner('POST', '/token')).text).token as string
check('a new token: the old one gets 404 at once, the new one 202',
  await send(`Bearer ${token}`) === 404 && await send(`Bearer ${next}`) === 202 && next !== token)

// A new token while an event (past the check with the old one) was still sending its body.
{
  const n = rows()
  const d = held(`Bearer ${next}`)
  check('an event past the check is arriving', await arriving(1) === 1)
  const newest = JSON.parse((await owner('POST', '/token')).text).token as string
  d.send()
  check('a new token while its body was on its way: 404, no row', await d.answer === 404 && rows() === n)
  const removed = await owner('DELETE', '/token')
  check('removing the token opens the URL again', removed.status === 200 && kept() === null
    && removed.text.includes('"tokenRequired":false') && await send() === 202 && await send(`Bearer ${newest}`) === 202)
  check('removing it again changes nothing', (await owner('DELETE', '/token')).status === 200 && kept() === null)
}

// The cap on events arriving at once. The bucket (burst 20) would refuse the 21st start too, so the test waits
// for it to refill before the next event: that one is refused by the cap alone.
{
  await new Promise(r => setTimeout(r, 2100))
  const n = rows()
  const open = Array.from({ length: WEBHOOK_MAX_OPEN_BODIES }, () => held())
  check(`${WEBHOOK_MAX_OPEN_BODIES} events arriving at once`, await arriving(WEBHOOK_MAX_OPEN_BODIES)
    === WEBHOOK_MAX_OPEN_BODIES)
  await new Promise(r => setTimeout(r, 1100))
  const res = await fetch(`${base}/api/webhooks/${secret}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mail":"over@x.com"}' })
  check('one more, with the bucket refilled: 429 with Retry-After, no row', res.status === 429
    && res.headers.get('retry-after') === '1' && /arriving at once/.test(await res.text()) && rows() === n)
  // The cap comes before the bucket: 15 more refused by it spend none of the sender's allowance (they would have
  // emptied the ~11 the bucket refilled, and the event after the held ones end would get "Rate limit exceeded").
  const capped: string[] = []
  for (let i = 0; i < 15; i++) {
    const r = await fetch(`${base}/api/webhooks/${secret}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mail":"over@x.com"}' })
    capped.push(`${r.status} ${await r.text()}`)
  }
  check('... 15 more refused by the cap', capped.every(c => /^429 .*arriving at once/.test(c)), capped)
  open[0].hangUp()
  check('a sender that hangs up frees its place', await arriving(WEBHOOK_MAX_OPEN_BODIES - 1)
    === WEBHOOK_MAX_OPEN_BODIES - 1)
  const rest = open.slice(1)
  for (const d of rest) d.send()
  const answers = await Promise.all(rest.map(d => d.answer))
  check('the held events still add their rows', answers.every(s => s === 202) && rows() === n + rest.length, answers)
  check('... and nothing is left counted once they end', await arriving(0) === 0)
  check('the events the cap refused spent none of the allowance: the next one is 202', await send() === 202)
}

server.close()
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('webhook auth token: all passed')

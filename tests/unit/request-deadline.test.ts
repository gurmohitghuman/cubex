// Over 200 lines: one server through the real chain, each part another way a request arrives.
// The deadline on receiving each request (lib/request-deadline.ts), through index.ts's middleware and the real
// routes on a real socket, with the deadline at 1 s and uploads at 50 KB/s. A body sent slowly to sign-in, which
// needs no account, or to a signed-in JSON route with a large declared size gets 408 and the server hangs up at the
// deadline; a route that answered before reading the body hangs up then too. A CSV upload, through an upload link
// and in the app, gets longer by its size: a 100 KB file sent over 1.5 s is imported, and one sent slower is cut
// off at its own deadline, leaving nothing behind. An answer that takes longer than the deadline, once the request
// is all in, isn't cut off. A request pipelined behind another's answer, its body never sent, is hung up at its
// deadline without a 408 landing inside that answer. Node's requestTimeout is the backstop past the longest deadline.
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'

// Read when the modules load, so before the imports below.
process.env.REQUEST_BODY_TIMEOUT_MS = '1000'
process.env.UPLOAD_MIN_KB_PER_SECOND = '50'
const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { signToken } = await import('../../server/src/lib/auth')
const { createFileLink } = await import('../../server/src/lib/file-links')
const { prepareUploadDir, UPLOAD_DIR } = await import('../../server/src/lib/uploads')
const { MAX_CSV_UPLOAD_BYTES } = await import('../../server/src/lib/constants')
const { HTTP_HEADERS_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS } = await import('../../server/src/lib/constants-server')
const { applyServerTimeouts } = await import('../../server/src/lib/server-timeouts')
const { applyServerMiddleware } = await import('../../server/src/lib/server-middleware')
const { requestDeadline, receiveBackstopMs, uploadDeadlineMs } = await import('../../server/src/lib/request-deadline')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
prepareUploadDir()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tid = uuid(), tokenId = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
db.prepare('INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes) VALUES (?,?,?,?,?,?)')
  .run(tokenId, uid, 'agent', crypto.randomBytes(32).toString('hex'), 'cubex_pat_x', 'read,write')
const sheet = () => {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
    .run(id, tid, uid, `S_${id.slice(0, 8)}`, '[]')
  return id
}
const rows = (sheetId: string) => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sheetId)
const uploadLink = (sheetId: string) =>
  createFileLink({ userId: uid, tokenId, sheetId, kind: 'upload', options: {} }).token
const leftovers = () => fs.readdirSync(UPLOAD_DIR).length

// As index.ts: the deadline first, then the global middleware and parsers, then the routes.
const app = express()
app.use(requestDeadline)
applyServerMiddleware(app, { isProduction: false })
app.use('/api/files', (await import('../../server/src/routes/file-links')).default)
app.use('/api/auth', (await import('../../server/src/routes/auth')).default)
app.use('/api/sheets', (await import('../../server/src/routes/sheets-csv-import')).default)
// Answers for 1.5 s, as a run's progress stream goes on: once its body is read (the global JSON parser), and
// under a prefix the global parsers skip, with nothing reading the body (it is all in, but never consumed).
const slowAnswer = (_req: unknown, res: import('express').Response) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 31 })
  let n = 0
  const tick = setInterval(() => {
    res.write(n ? ',1' : '[1')
    if (++n === 15) { clearInterval(tick); res.end(']') }
  }, 100)
}
app.post('/api/slow-answer', slowAnswer)
app.post('/api/files/slow-answer', slowAnswer)
app.use(['/api', '/mcp'], (_req, res) => { res.status(404).json({ error: 'Not found' }) })
const server = app.listen(0, '127.0.0.1')
applyServerTimeouts(server, receiveBackstopMs())
await new Promise(r => server.once('listening', r))
const port = (server.address() as AddressInfo).port
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`

// A request on a raw socket, its body sent `chunk` bytes every `everyMs`. Unless `close`, it asks to keep the
// connection open, so it ends only when the server hangs up. status: the answer's (0 if none); ms: from the
// headers to the hang-up (the test gives up at 8 s).
type Sent = { status: number; ms: number; sent: number; body: string }
function send(method: string, path: string, body: Buffer, o: { chunk: number; everyMs: number; close?: boolean;
  headers?: Record<string, string> }): Promise<Sent> {
  return new Promise(resolve => {
    const sock = net.connect(port, '127.0.0.1')
    const head = [`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1', `Content-Length: ${body.length}`,
      ...(o.close ? ['Connection: close'] : []), ...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`)]
    let text = '', sent = 0
    sock.write(head.join('\r\n') + '\r\n\r\n')
    const started = Date.now()
    const drip = setInterval(() => {
      if (sent >= body.length || sock.destroyed) return
      sock.write(body.subarray(sent, sent + o.chunk))
      sent = Math.min(body.length, sent + o.chunk)
    }, o.everyMs)
    const giveUp = setTimeout(() => sock.destroy(), 8000)
    sock.on('data', d => { text += d.toString() })
    sock.on('error', () => {})
    sock.on('close', () => {
      clearInterval(drip)
      clearTimeout(giveUp)
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0)
      resolve({ status, ms: Date.now() - started, sent, body: text.slice(text.indexOf('\r\n\r\n') + 4) })
    })
  })
}
const json = { 'Content-Type': 'application/json' }
const near = (r: Sent, ms: number) => r.ms >= ms - 100 && r.ms < ms + 700
const csv = (n: number) => Buffer.from('email,note\n'
  + Array.from({ length: n }, (_, i) => `p${i}@x.com,${'n'.repeat(40)}`).join('\n') + '\n')
const file = csv(2000) // about 100 KB: an upload's deadline is 1 s + 2 s
const uploadMs = uploadDeadlineMs(file.length)

// Slow bodies: sign-in needs no account; the app's JSON routes read a body only when signed in.
{
  const login = await send('POST', '/api/auth/login', Buffer.from(JSON.stringify({ password: 'p'.repeat(60) })),
    { chunk: 1, everyMs: 100, headers: json })
  check('a sign-in sent slowly: 408 and the server hangs up at the deadline', login.status === 408
    && near(login, 1000), login)
  const big = await send('POST', '/api/tables', Buffer.alloc(100 * 1024, 32), { chunk: 1024, everyMs: 100,
    headers: { ...json, Cookie: cookie } })
  check('signed in, a JSON body with a large declared size gets the same deadline (only an upload gets more)',
    big.status === 408 && near(big, 1000), { status: big.status, ms: big.ms })
  const early = await send('PUT', '/api/files/upload/not-a-link', file, { chunk: 1024, everyMs: 100 })
  check('a route that answered before reading the body: the server hangs up at the deadline', early.status === 404
    && near(early, 1000), { status: early.status, ms: early.ms })
}

// Uploads get longer, by their size.
{
  check('an upload of about 100 KB gets 3 s at 50 KB/s', uploadMs > 2900 && uploadMs < 3200, uploadMs)
  const s1 = sheet()
  const link = await send('PUT', `/api/files/upload/${uploadLink(s1)}`, file,
    { chunk: 10_240, everyMs: 150, close: true })
  check('through an upload link, sent over 1.5 s (past the 1 s deadline): imported', link.status === 201
    && rows(s1) === 2000, { status: link.status, ms: link.ms, rows: rows(s1), body: link.body.slice(0, 200) })
  const s2 = sheet()
  const slow = await send('PUT', `/api/files/upload/${uploadLink(s2)}`, file, { chunk: 1024, everyMs: 100 })
  await new Promise(r => setTimeout(r, 200))
  check('sent slower than 50 KB/s: 408 and hung up at its own deadline, nothing imported, no file left',
    slow.status === 408 && near(slow, uploadMs) && rows(s2) === 0 && leftovers() === 0,
    { status: slow.status, ms: slow.ms, rows: rows(s2), leftovers: leftovers() })

  const boundary = `b${crypto.randomBytes(8).toString('hex')}`
  const form = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; `
    + 'filename="leads.csv"\r\nContent-Type: text/csv\r\n\r\n'), file, Buffer.from(`\r\n--${boundary}--\r\n`)])
  const formHeaders = { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Cookie: cookie }
  const s3 = sheet()
  const inApp = await send('POST', `/api/sheets/${s3}/import`, form,
    { chunk: 10_240, everyMs: 150, close: true, headers: formHeaders })
  check('in the app, signed in, sent over 1.5 s: imported', inApp.status === 200 && rows(s3) === 2000,
    { status: inApp.status, ms: inApp.ms, rows: rows(s3), body: inApp.body.slice(0, 200) })
  const s4 = sheet()
  const slowApp = await send('POST', `/api/sheets/${s4}/import`, form,
    { chunk: 1024, everyMs: 100, headers: formHeaders })
  check('in the app, sent slower: 408 and hung up at its own deadline, nothing imported',
    slowApp.status === 408 && near(slowApp, uploadDeadlineMs(form.length)) && rows(s4) === 0,
    { status: slowApp.status, ms: slowApp.ms, rows: rows(s4) })
}

// Once a request is all in, its answer isn't timed; and the server is fine after the cut-offs.
{
  for (const [path, label] of [['/api/slow-answer', 'its body read'], ['/api/files/slow-answer', 'its body unread']]) {
    const answer = await send('POST', path, Buffer.from('{"a":1}'), { chunk: 100, everyMs: 10, close: true,
      headers: { ...json, Cookie: cookie } })
    check(`an answer that takes 1.5 s, longer than the deadline, comes whole (${label})`, answer.status === 200
      && answer.body === '[1' + ',1'.repeat(14) + ']' && answer.ms >= 1400, { status: answer.status, ms: answer.ms })
  }
  const after = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: json,
    body: JSON.stringify({ password: 'p' }) })
  check('the server still answers at once after the cut-offs', after.status > 0 && after.status !== 408,
    after.status)
}

// A request pipelined behind another's answer, its body never sent: at its deadline the server hangs up (the
// answer before it is cut short), and its 408 isn't written into that answer, whose socket it doesn't own yet.
{
  const piped = await new Promise<{ text: string; ms: number }>(resolve => {
    const sock = net.connect(port, '127.0.0.1')
    let text = ''
    const started = Date.now()
    sock.write('POST /api/slow-answer HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
      + `Cookie: ${cookie}\r\nContent-Length: 7\r\n\r\n{"a":1}POST /api/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\n`
      + 'Content-Type: application/json\r\nContent-Length: 50\r\n\r\n')
    const giveUp = setTimeout(() => sock.destroy(), 8000)
    sock.on('data', d => { text += d.toString() })
    sock.on('error', () => {})
    sock.on('close', () => { clearTimeout(giveUp); resolve({ text, ms: Date.now() - started }) })
  })
  check('pipelined behind a slow answer, its body never sent: hung up at its deadline, no 408 inside the answer',
    piped.text.startsWith('HTTP/1.1 200') && !piped.text.includes('HTTP/1.1 408') && piped.ms >= 900
    && piped.ms < 1400, { ms: piped.ms, text: piped.text.slice(-60) })
}

// Node's own deadline, from a request's first byte, is past the longest one here.
{
  const longest = uploadDeadlineMs(MAX_CSV_UPLOAD_BYTES)
  check('the server\'s requestTimeout: the headers\' deadline, the largest upload\'s, and a minute',
    server.requestTimeout === HTTP_HEADERS_TIMEOUT_MS + longest + 60_000, server.requestTimeout)
  const defaults = HTTP_HEADERS_TIMEOUT_MS + 120_000 + (500 * 1024 * 1024) / (128 * 1024) * 1000 + 60_000
  check('a test server\'s fallback covers the default settings\' backstop', defaults <= HTTP_REQUEST_TIMEOUT_MS,
    { defaults, fallback: HTTP_REQUEST_TIMEOUT_MS })
}

server.close()
server.closeAllConnections()
if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall request deadline checks passed')

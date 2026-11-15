// The deadline on an answer whose client stopped reading it (lib/answer-stall.ts), through index.ts's chain and the
// real routes, the deadline at 1 s, on a Unix socket (answer-stall-kit.ts says why). A client that stops reading is
// cut after about that long, whatever writes the answer: one large write, a stream still writing, express.static,
// res.sendFile, a CSV export through a download link, /api/v1 or pipelined behind another request (its sheet then
// free). A steady reader gets all of one large write, also pipelined. Nothing silent is timed: a paused run's
// progress stream, read or not, a quiet event stream, a late handler. A small answer never read finishes, and the
// keep-alive timeout closes it; a keep-alive request after a large answer is answered. On Windows, which shows no
// progress inside a write, the write in flight gets more time by its size, so the bounds there allow for it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stallKit, sleep } from './answer-stall-kit'

// Read when the modules load, so before the imports below.
process.env.RESPONSE_STALL_TIMEOUT_MS = '1000'
process.env.RESPONSE_MIN_KB_PER_SECOND = '2048'
const STALL = 1000
const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { createFileLink } = await import('../../server/src/lib/file-links')
const { generateAccessToken } = await import('../../server/src/lib/access-token')
const { withSheetBusy } = await import('../../server/src/lib/sheet-busy')
const { writeSSEHeaders } = await import('../../server/src/lib/sse')
const { escapeC1InJson } = await import('../../server/src/lib/json-c1-escape')
const { answerStall } = await import('../../server/src/lib/answer-stall')
const { signToken } = await import('../../server/src/lib/auth')
const { requestDeadline } = await import('../../server/src/lib/request-deadline')
const { applyServerMiddleware } = await import('../../server/src/lib/server-middleware')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const { check, logged, closedAt, tagged, listen, open, stalled, steady } = stallKit('stall')

// A sheet whose CSV (about 12 MB) is larger than the socket buffers, and a read token.
const uid = uuid(), tid = uuid(), sid = uuid(), tokenId = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Notes']))
const insertRow = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
db.transaction(() => {
  for (let i = 0; i < 40_000; i++) {
    insertRow.run(uuid(), sid, uid, i, JSON.stringify({ Notes: `${'n'.repeat(300)}${i}` }))
  }
}).immediate()
const pat = generateAccessToken()
db.prepare('INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes) VALUES (?,?,?,?,?,?)')
  .run(tokenId, uid, 'agent', pat.tokenHash, pat.tokenPrefix, 'read')
// A paused run, for its progress stream, and a session for the stream.
const runId = uuid()
db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
  VALUES (?, ?, ?, ?, ?, ?, 'paused')`).run(runId, sid, uid, 'Fit', 'Is /Notes a fit?', 'test/model')
const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
const exportBusy = async () => {
  const r = await withSheetBusy(sid, 'checking', async () => 'ran')
  return typeof r === 'object' ? r.busy : r
}

// A 16 MB file for express.static and res.sendFile.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-'))
const BIG = 16 * 1024 * 1024
fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(BIG, 120))

// As index.ts: the escaping, the stall deadline, the request deadline, the global middleware, then the routes.
const app = express()
app.use(tagged)
app.use(escapeC1InJson)
app.use(answerStall)
app.use(requestDeadline)
applyServerMiddleware(app, { isProduction: false })
app.use('/api/files', (await import('../../server/src/routes/file-links')).default)
app.use('/api/v1', (await import('../../server/src/routes/api-v1')).default)
app.use('/api/ai', (await import('../../server/src/routes/ai-stream')).default)
app.use('/static', express.static(dir))
app.get('/t/sendfile', (_req, res) => res.sendFile(path.join(dir, 'big.bin')))
app.get('/t/big', (_req, res) => { res.type('application/octet-stream').end(Buffer.alloc(BIG, 120)) })
app.get('/t/two-mb', (_req, res) => { res.type('application/octet-stream').end(Buffer.alloc(2 * 1024 * 1024, 120)) })
// An event stream that goes on writing: 64 KB every 10 ms, so the socket buffers fill within a second.
app.get('/t/events', (_req, res) => {
  writeSSEHeaders(res)
  const tick = setInterval(() => res.write(`data: ${'x'.repeat(65_536)}\n\n`), 10)
  res.on('close', () => clearInterval(tick))
})
// Silent longer than the deadline, then one event: a paused run's progress stream.
app.get('/t/quiet', (_req, res) => {
  writeSSEHeaders(res)
  const later = setTimeout(() => res.end('data: {"type":"done"}\n\n'), 2500)
  res.on('close', () => clearTimeout(later))
})
app.get('/t/slow', (_req, res) => { setTimeout(() => res.json({ ok: true }), 2500) })
const finished: number[] = []
app.get('/t/small', (_req, res) => {
  res.on('finish', () => finished.push(Date.now()))
  res.json({ small: 'x'.repeat(1000) })
})
const closeServer = await listen(app)

// Windows shows no progress inside a write: there the write in flight gets one more second per 2 MB (the setting).
const UNSEEN = process.platform === 'win32' ? BIG / (2048 * 1024) * 1000 : 0
const cutInTime = (ms: number) => ms >= STALL - 100 && ms < 3 * STALL + 500 + UNSEEN

// Clients that stop reading are cut off, whatever writes the answer.
{
  const big = await stalled('/t/big', {}, undefined, 8000 + UNSEEN)
  check(`one large write, client stopped reading: cut after ${big} ms`, cutInTime(big), big)
  const events = await stalled('/t/events', {}, undefined, 8000 + UNSEEN)
  check(`an event stream still writing, client stopped reading: cut after ${events} ms (its buffers fill first)`,
    events >= STALL && events < 5 * STALL + UNSEEN, events)
  const stat = await stalled('/static/big.bin')
  check(`a file through express.static: cut after ${stat} ms`, cutInTime(stat), stat)
  const sent = await stalled('/t/sendfile')
  check(`a file through res.sendFile: cut after ${sent} ms`, cutInTime(sent), sent)
}

// A CSV export held by a client that stopped reading: cut off, and the sheet is free again.
const bearer = { Authorization: `Bearer ${pat.token}` }
for (const [label, p, headers] of [
  ['through a download link', () => `/api/files/download/${createFileLink({ userId: uid, tokenId, sheetId: sid,
    kind: 'download', options: {} }).token}`, {}],
  ['through /api/v1 with a read token', () => `/api/v1/sheets/${sid}/export`, bearer],
  ['pipelined behind another request', () => [`/api/v1/sheets/${uuid()}/export`, `/api/v1/sheets/${sid}/export`],
    bearer],
] as const) {
  let during = ''
  const ms = await stalled(p(), headers, async () => { await sleep(STALL / 2); during = await exportBusy() })
  await sleep(50)
  const after = await exportBusy()
  check(`an export ${label}, client stopped reading: the sheet held, then cut after ${ms} ms and free`,
    /exporting/.test(during) && cutInTime(ms) && after === 'ran', { during, ms, after })
}

// A slow but steady reader gets all of one large write, however long it takes, also queued behind a small answer
// (it goes out once that one is done).
for (const paths of [['/t/big'], ['/t/small', '/t/big']]) {
  const r = await steady(paths)
  check(`a steady reader of one large write${paths.length > 1 ? ' queued behind another answer' : ''} gets all of it`
    + ` over ${r.ms} ms`, r.got.length === paths.length && r.got.every(g => g.bytes === g.length)
    && r.got.at(-1)!.length === BIG && r.ms > 2 * STALL, r)
}

// Nothing silent is timed.
{
  // A paused run's progress stream, read and not read: open 8 times the deadline, its events in.
  const stream = `/api/ai/runs/${runId}/stream`
  let text = ''
  const reader = open(`${stream}?c=reader`, { Cookie: cookie })
  reader.on('data', d => { text += d })
  const unread = await stalled(stream, { Cookie: cookie })
  check('a paused run\'s progress stream, read or never read, is open 8 times the deadline later',
    unread === -1 && !closedAt.has('reader') && !reader.destroyed && /"status":"paused"/.test(text),
    { unread, text: text.slice(-120) })
  reader.destroy()

  const quiet = await new Promise<string>(resolve => {
    const c = open('/t/quiet')
    let text = ''
    c.on('data', d => { text += d })
    c.on('close', () => resolve(text))
    setTimeout(() => c.destroy(), 6000)
  })
  check('an event stream silent for 2.5 s keeps its connection, and its event arrives', quiet.includes('"done"'),
    quiet.slice(-80))
  const slow = (await steady('/t/slow')).got[0]
  check('a handler answering after 2.5 s is delivered', slow?.status === 200 && slow.bytes === '{"ok":true}'.length,
    slow)
}

// A small answer to a client that never reads finishes; the keep-alive timeout closes the connection.
{
  const from = finished.length
  const ms = await stalled('/t/small')
  check(`a small answer, never read: finished at once, closed by the keep-alive timeout after ${ms} ms`,
    finished.length === from + 1 && ms >= 2900 && ms < 4500, { ms, finished: finished.length - from })
}

// A keep-alive request after a large answer read in full, past the deadline: answered.
{
  const c = open('/t/two-mb')
  let text = ''
  c.on('data', d => { text += d.toString('latin1') })
  while (text.length < 2 * 1024 * 1024) await sleep(20)
  await sleep(2 * STALL)
  const before = text.length
  c.write('GET /t/small HTTP/1.1\r\nHost: localhost\r\n\r\n')
  await sleep(300)
  check('a keep-alive request 2 s after a large answer is answered on the same connection',
    text.slice(before).startsWith('HTTP/1.1 200') && !c.destroyed, text.slice(before, before + 40))
  c.destroy()
}

check('nothing logged', logged.length === 0, logged.slice(0, 3))
fs.rmSync(dir, { recursive: true, force: true })
closeServer()
console.log('\nall answer stall checks passed')

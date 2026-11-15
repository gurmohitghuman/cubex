// An export holds the rows there when it begins, up to the last of them (lib/csv-write.ts eachPage): rows added
// while it goes out are not in it, so a sheet that keeps growing can't keep it, and its hold on the sheet, going.
// Through /api/v1 and a download link, on a Unix socket (answer-stall-kit.ts): a client that stops reading while
// rows are appended through the service and through the webhook route gets exactly the rows from the start, and
// the sheet is free once it ends. One reading about 400 KB/s while rows are appended faster than that (it would
// never catch up with the sheet's end) ends too. export_csv (buildSheetCsv) holds the same rows.
import http from 'node:http'
import { stallKit, sleep } from './answer-stall-kit'

const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { createFileLink } = await import('../../server/src/lib/file-links')
const { generateAccessToken } = await import('../../server/src/lib/access-token')
const { generateWebhookToken } = await import('../../server/src/lib/webhook-token')
const { withSheetBusy } = await import('../../server/src/lib/sheet-busy')
const { appendRows } = await import('../../server/src/services/rows-write')
const { buildSheetCsv } = await import('../../server/src/lib/csv-export')
const { answerStall } = await import('../../server/src/lib/answer-stall')
const { applyServerMiddleware } = await import('../../server/src/lib/server-middleware')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
const { check, logged, listen, sock } = stallKit('export-stop')

// A sheet of `n` rows, each about 300 bytes of CSV (larger than the socket buffers), with a webhook into it.
const uid = uuid(), tid = uuid(), tokenId = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
const insertRow = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
function sheet(n: number) {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
    .run(sid, tid, uid, `S${sid}`, JSON.stringify(['Email', 'Notes']))
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      insertRow.run(uuid(), sid, uid, i, JSON.stringify({ Email: `first${i}@x.co`, Notes: 'n'.repeat(280) }))
    }
  }).immediate()
  const hook = generateWebhookToken(), src = uuid()
  db.prepare(`INSERT INTO webhook_sources (id, user_id, sheet_id, token_hash, raw_column_name)
    VALUES (?, ?, ?, ?, ?)`).run(src, uid, sid, hook.tokenHash, 'Webhook')
  db.prepare('INSERT INTO webhook_mappings (id, source_id, user_id, json_path, column_name) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), src, uid, '$.email', 'Email')
  return { sid, hook: hook.secret }
}
const pat = generateAccessToken()
db.prepare('INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes) VALUES (?,?,?,?,?,?)')
  .run(tokenId, uid, 'agent', pat.tokenHash, pat.tokenPrefix, 'read')
const count = (sid: string) => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const free = async (sid: string) => {
  const r = await withSheetBusy(sid, 'checking', async () => 'ran')
  return typeof r === 'object' ? r.busy : r
}
// The rows an export's CSV holds, by their Email: the first `n`, in order, and nothing else.
const exactly = (csv: string, n: number) => {
  const lines = csv.split('\r\n')
  return lines[0] === '"Email","Notes"' && lines.length === n + 1
    && lines.slice(1).every((l, i) => l.startsWith(`"first${i}@x.co",`))
}

const app = express()
app.use(answerStall)
applyServerMiddleware(app, { isProduction: false })
app.use('/api/files', (await import('../../server/src/routes/file-links')).default)
app.use('/api/v1', (await import('../../server/src/routes/api-v1')).default)
app.use('/api/webhooks', (await import('../../server/src/routes/webhooks-public')).default)
const closeServer = await listen(app)

const bearer = { Authorization: `Bearer ${pat.token}` }
const download = (sid: string) => `/api/files/download/${createFileLink({ userId: uid, tokenId, sheetId: sid,
  kind: 'download', options: {} }).token}`
// A request over the socket; the answer comes as it is read: `per` bytes every 20 ms, or all of it when 0, once
// `go` resolves. The body, whether all of it came, and the time from the request.
function get(path: string, headers: Record<string, string>, per: number, go: Promise<void> = Promise.resolve()) {
  return new Promise<{ body: string; whole: boolean; ms: number }>(resolve => {
    const started = Date.now(), parts: Buffer[] = []
    let tick: NodeJS.Timeout | undefined
    const done = (whole: boolean) => {
      clearInterval(tick)
      resolve({ body: Buffer.concat(parts).toString(), whole, ms: Date.now() - started })
    }
    const req = http.get({ socketPath: sock, path, headers, agent: false })
    req.on('error', () => done(false))
    req.on('response', res => {
      let ended = false
      res.pause()
      res.on('error', () => {})
      res.once('end', () => { ended = true; done(true) })
      res.once('close', () => { if (!ended) done(false) })
      void go.then(() => {
        if (per === 0) { res.on('data', d => parts.push(d)); res.resume(); return }
        tick = setInterval(() => { const b = res.read(per); if (b) parts.push(b) }, 20)
      })
    })
  })
}
const hook = (secret: string, email: string) => new Promise<number>(resolve => {
  const body = JSON.stringify({ email })
  const req = http.request({ socketPath: sock, path: `/api/webhooks/${secret}`, method: 'POST', agent: false,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } })
  req.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
  req.on('error', () => resolve(0))
  req.end(body)
})

// Rows appended while the client isn't reading: 50 through the service, 5 through the webhook route.
const surfaces = [['through /api/v1', 'v1', bearer], ['through a download link', 'link', {}]] as const
for (const [label, path, headers] of surfaces) {
  const n = 12_000
  const s = sheet(n)
  let go!: () => void
  const read = get(path === 'v1' ? `/api/v1/sheets/${s.sid}/export` : download(s.sid), headers, 0,
    new Promise<void>(r => { go = r }))
  await sleep(300)
  const during = await free(s.sid)
  const added = appendRows(s.sid, uid, Array.from({ length: 50 }, (_, i) => ({ Email: `later${i}@x.co` })))
  const hooks = await Promise.all([0, 1, 2, 3, 4].map(i => hook(s.hook, `hook${i}@x.co`)))
  go()
  const out = await read
  await sleep(50)
  check(`an export ${label}, 55 rows appended while it waits on its client (50 by the service, 5 by the webhook): `
    + `exactly the ${n} rows from its start, then the sheet is free`,
  /exporting/.test(during) && 'ok' in added && hooks.every(h => h === 202) && count(s.sid) === n + 55
    && out.whole && exactly(out.body, n) && await free(s.sid) === 'ran',
  { during, hooks, rows: count(s.sid), whole: out.whole, lines: out.body.split('\r\n').length })
}

// A sheet that keeps growing faster than the client reads: 30 rows of about 300 bytes every 10 ms (up to 900 KB
// of CSV a second) while it reads 8 KB every 20 ms (400 KB a second). Without the stop it never ends.
{
  const n = 6000
  const s = sheet(n)
  let k = 0
  const growing = setInterval(() => {
    appendRows(s.sid, uid, Array.from({ length: 30 }, () => ({ Email: `later${k++}@x.co`, Notes: 'm'.repeat(280) })))
  }, 10)
  let giveUp: NodeJS.Timeout | undefined
  const out = await Promise.race([get(`/api/v1/sheets/${s.sid}/export`, bearer, 8192),
    new Promise<{ body: string; whole: boolean; ms: number }>(r => {
      giveUp = setTimeout(() => r({ body: '', whole: false, ms: -1 }), 30_000)
    })])
  clearTimeout(giveUp)
  clearInterval(growing)
  await sleep(50)
  check(`an export read 8 KB every 20 ms while rows are appended faster ends after ${out.ms} ms with exactly the `
    + `${n} rows from its start (${k} added meanwhile), then the sheet is free`,
  out.whole && exactly(out.body, n) && k > 1000 && await free(s.sid) === 'ran',
  { whole: out.whole, ms: out.ms, added: k, lines: out.body.split('\r\n').length })
}

// export_csv reads a page, then yields: rows appended then are not in it.
{
  const n = 7000
  const s = sheet(n)
  const csv = buildSheetCsv(s.sid, uid)
  const added = appendRows(s.sid, uid, Array.from({ length: 50 }, (_, i) => ({ Email: `later${i}@x.co` })))
  const out = await csv
  check(`export_csv: rows appended after its first page are not in it, exactly the ${n} from its start`,
    'ok' in added && count(s.sid) === n + 50 && 'ok' in out && out.ok && out.rowCount === n && exactly(out.csv, n),
    'ok' in out && out.ok ? { rowCount: out.rowCount } : out)
}

check('nothing logged', logged.length === 0, logged.slice(0, 3))
closeServer()
console.log('\nall export stop checks passed')

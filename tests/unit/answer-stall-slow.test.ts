// The deadline on an answer whose client stopped reading it (lib/answer-stall.ts), for a client that reads slowly
// but steadily: a 3 MB CSV export read at about 400 KB/s, slower than one of its 1 MB writes per deadline (1 s),
// still arrives whole. So progress inside a write counts from where the write starts, though res.write hands it to
// the system only on the next tick. On Windows, which shows no progress inside a write, the write in flight gets
// one more second per 128 KB of it (8 s for 1 MB), more than this reader needs.
import http from 'node:http'
import { stallKit } from './answer-stall-kit'

// Read when the modules load, so before the imports below.
process.env.RESPONSE_STALL_TIMEOUT_MS = '1000'
process.env.RESPONSE_MIN_KB_PER_SECOND = '128'
const STALL = 1000
const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { generateAccessToken } = await import('../../server/src/lib/access-token')
const { answerStall } = await import('../../server/src/lib/answer-stall')
const { requestDeadline } = await import('../../server/src/lib/request-deadline')
const { applyServerMiddleware } = await import('../../server/src/lib/server-middleware')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const { check, logged, listen, sock } = stallKit('slow')

// A sheet whose CSV is about 3 MB, one page of rows, so it goes out in three writes of at most 1 MB; a read token.
const uid = uuid(), tid = uuid(), sid = uuid(), tokenId = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Notes']))
const insertRow = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
db.transaction(() => {
  for (let i = 0; i < 3000; i++) insertRow.run(uuid(), sid, uid, i, JSON.stringify({ Notes: `${'n'.repeat(999)}${i}` }))
}).immediate()
const pat = generateAccessToken()
db.prepare('INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes) VALUES (?,?,?,?,?,?)')
  .run(tokenId, uid, 'agent', pat.tokenHash, pat.tokenPrefix, 'read')

// As index.ts: the stall deadline, the request deadline, the global middleware, then the routes.
const app = express()
app.use(answerStall)
app.use(requestDeadline)
applyServerMiddleware(app, { isProduction: false })
app.use('/api/v1', (await import('../../server/src/routes/api-v1')).default)
const closeServer = await listen(app)

// Reads the sheet's export, `per` bytes every 20 ms (as it comes when 0): the body, whether all of it came, the time.
function read(per: number): Promise<{ body: string; whole: boolean; ms: number }> {
  return new Promise(resolve => {
    const started = Date.now(), parts: Buffer[] = []
    let tick: NodeJS.Timeout | undefined
    const done = (whole: boolean) => {
      clearInterval(tick)
      tick = undefined
      resolve({ body: Buffer.concat(parts).toString(), whole, ms: Date.now() - started })
    }
    const req = http.get({ socketPath: sock, path: `/api/v1/sheets/${sid}/export`, agent: false,
      headers: { Authorization: `Bearer ${pat.token}` } })
    req.on('error', () => done(false))
    req.on('response', res => {
      let ended = false
      res.on('error', () => {})
      res.once('end', () => { ended = true; done(true) })
      res.once('close', () => { if (!ended) done(false) })
      if (per === 0) { res.on('data', d => parts.push(d)); return }
      tick = setInterval(() => { const b = res.read(per); if (b) parts.push(b) }, 20)
    })
  })
}

const fast = await read(0)
check(`the export read as it comes: ${fast.body.length} bytes`, fast.whole && fast.body.length > 3_000_000
  && fast.body.split('\r\n').length >= 3001, { whole: fast.whole, bytes: fast.body.length })
const slow = await read(8192)
check(`the export read 8 KB every 20 ms arrives whole over ${slow.ms} ms, slower than 1 MB per deadline`,
  slow.whole && slow.body === fast.body && slow.ms > 3 * STALL,
  { whole: slow.whole, bytes: slow.body.length, ms: slow.ms })

check('nothing logged', logged.length === 0, logged.slice(0, 3))
closeServer()
console.log('\nall slow reader checks passed')

// What the AI spend-limit tests share (ai-spend-gate-*.test.ts): a stand-in
// for OpenRouter on 127.0.0.1 (a model list with prices, a chat endpoint that
// bills each call, both steerable), then, once the server's modules can load
// (OPENROUTER_BASE_URL is read when they do), a user with a key and sheets of
// rows waiting on a run. Not a test itself (no .test.ts).
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'

export const PRICED = 'test/priced'
// openrouter/auto's way of saying its price varies: no listed price.
export const VARIES = 'test/varies'
// Its request fee varies: no listed price either.
export const FEE_VARIES = 'test/fee-varies'

export interface StandIn {
  costUsd: number                 // what each call bills
  delayMs: number                 // before each answer
  models: 'ok' | 'fail'           // the model list answers, or fails with a 503
  modelsFailFirst: number         // fail this many model list reads, then answer
  modelsHits: number
  calls: number
  // Per call (1-based): 'ok', 'cut' (a 200 whose body breaks off: the call may be billed), 'reset' (the
  // connection is reset, no answer), an error status with OpenRouter's error body ({ error: { code, message,
  // metadata } }), or wait for a promise (then answer as it says, 'ok' by default).
  answer: (n: number) => Answer | Promise<Answer | void>
  // Per call (1-based): fields merged into its usage block (is_byok, cost_details, completion_tokens_details...).
  usage: (n: number) => Record<string, unknown>
  // Every chat call's request body, parsed, in order.
  bodies: Array<Record<string, any>>
  // GETs answered with this JSON, by the end of their path (e.g. '/tools/openrouter:web_fetch').
  gets: Record<string, unknown>
}
type Answer = 'ok' | 'cut' | 'reset' | { status: number; message: string; metadata?: Record<string, unknown> }

export async function startStandIn(): Promise<StandIn & { close: () => void }> {
  const s: StandIn = {
    costUsd: 0.005, delayMs: 50, models: 'ok', modelsFailFirst: 0, modelsHits: 0, calls: 0, answer: () => 'ok',
    usage: () => ({}), bodies: [], gets: {},
  }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      const got = Object.keys(s.gets).find(k => req.method === 'GET' && req.url?.endsWith(k))
      if (got) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(s.gets[got]))
        return
      }
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        s.modelsHits++
        if (s.models === 'fail' || s.modelsFailFirst > 0) {
          s.modelsFailFirst = Math.max(0, s.modelsFailFirst - 1)
          res.writeHead(503).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [
          { id: PRICED, name: PRICED, pricing: { prompt: '0.000001', completion: '0.000001' } },
          { id: VARIES, name: VARIES, pricing: { prompt: '-1', completion: '-1' } },
          { id: FEE_VARIES, name: FEE_VARIES, pricing: { prompt: '0.000001', completion: '0.000001', request: '-1' } },
        ] }))
        return
      }
      if (!req.url?.includes('/chat/completions')) { res.writeHead(404).end(); return }
      try { s.bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { s.bodies.push({}) }
      const n = ++s.calls
      const how = (await s.answer(n)) ?? 'ok'
      await new Promise(r => setTimeout(r, s.delayMs))
      if (how === 'reset') { req.socket.resetAndDestroy(); return }
      if (typeof how === 'object') {
        res.writeHead(how.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: how.status, message: how.message, metadata: how.metadata } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      if (how === 'cut') { res.end('{"id":"gen-cut","choices":['); return }
      res.end(JSON.stringify({
        id: `gen-${n}`, object: 'chat.completion', created: 0, model: PRICED,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: s.costUsd, ...s.usage(n) },
      }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  return Object.assign(s, { close: () => server.close() })
}

export const OUT = 'Hi (Output)'
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The world the runs work in: call after startStandIn.
export async function world() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { encrypt } = await import('../../server/src/lib/crypto')
  const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
  runMigrations()
  console.warn = () => {}
  console.error = () => {}
  // Only the test's own lines: the runner's logs stay out.
  const log = console.log
  console.log = (...a: unknown[]) => { if (typeof a[0] === 'string' && /^(ok|FAIL)/.test(a[0])) log(...a) }
  // Resuming queues a job: the tests call the worker directly instead.
  const sidequest = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
  sidequest.Sidequest.build = () => ({ enqueue: async () => ({}) })

  const uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
    .run(uuid(), uid, encrypt('sk-or-test'))

  // A sheet of `n` rows; with a run, their output cells ⏳ and that run (pending).
  function sheetOf(n: number) {
    const sid = uuid()
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
      .run(sid, tid, uid, `S-${sid.slice(0, 6)}`, JSON.stringify(['name']))
    for (let i = 0; i < n; i++) {
      db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
        .run(uuid(), sid, uid, i, JSON.stringify({ name: `N${i}` }))
    }
    return sid
  }
  function runOf(n: number, concurrency: number, limit: number | null, model = PRICED) {
    const sid = sheetOf(n), runId = uuid()
    db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['name', OUT]), sid)
    db.prepare(`UPDATE rows SET data = json_set(data, ?, ?) WHERE sheet_id = ?`).run(`$."${OUT}"`, PLACEHOLDER, sid)
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status,
      total_rows, spend_limit_usd) VALUES (?,?,?,?,'Say hi to /name',?,?,'pending',?,?)`)
      .run(runId, sid, uid, OUT, model, concurrency, n, limit)
    return { sid, runId }
  }
  const cells = (sid: string) => db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE sheet_id = ?
    ORDER BY row_index`).pluck().all(`$."${OUT}"`, sid) as string[]
  const runRow = (id: string) => db.prepare(`SELECT status, pause_reason, error_message, worker_generation,
    spend_limit_usd FROM ai_runs WHERE id = ?`).get(id) as {
      status: string; pause_reason: string | null; error_message: string | null; worker_generation: number;
      spend_limit_usd: number | null }
  const holds = (runId: string) => db.prepare('SELECT COUNT(*) FROM ai_run_holds WHERE run_id = ?')
    .pluck().get(runId) as number
  const runById = (id: string) => db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(id)

  let failures = 0
  const ok = async (label: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log('ok  ', label) }
    catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
  }
  const done = () => { if (failures) { console.log(`${failures} failed`); process.exit(1) } }
  return { db, uid, tid, PLACEHOLDER, sheetOf, runOf, cells, runRow, holds, runById, ok, done }
}

// A worker that should end by itself: past `ms` it is paused by hand (so its
// loop stops and the test can go on) and the wait fails.
export async function endsWithin(run: Promise<void>, ms: number, stop: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), ms) })
  const first = await Promise.race([run.then(() => 'ended' as const), late])
  clearTimeout(timer)
  if (first === 'late') {
    stop()
    await run
    throw new Error(`the run was still going after ${ms} ms: it waited for good`)
  }
}

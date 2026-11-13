// Over 200 lines: one stand-in, one queue and the sheets serve every scene; split, each would rebuild them.
// A run whose rows wait for a column another run holds says so from the database (migration 057's waiting_on,
// lib/run-waiting.ts; services/run-waiting-status.ts reads it): the column, the run that holds it, how many rows
// wait, and words for what that run is doing. The queue is the park test's (tests/unit/run-park.test.ts): the real
// job classes, a fixed number of slots, a snoozed job keeping its place. Writes and claims are counted by triggers
// on the throwaway database.
//   - the keeper: a write only when what it waits for changes, a count of rows in lookup steps at most once per
//     interval, nothing for a job a resume moved on; a stored value that doesn't read is no wait;
//   - the words for each state of the holder, a parked run, rows on another sheet;
//   - a reader behind a paused holder parks, says so, and in many wakes writes once (it parks on its first look)
//     and is never claimed again (its job snoozes again before the claim); once the holder goes on, it finishes
//     and says nothing;
//   - a reader behind a running holder waits in place and says the holder is still filling; it ends cleared;
//   - an AI run behind a queued holder parks the same way: its own waiting_on, its summary and the app's list.
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.RUN_INPUT_WAIT_POLL_MS = '100'
process.env.RUN_PARK_MS = '200'
process.env.RUN_PARK_PAUSED_MS = '300'
process.env.SIDEQUEST_POLL_MS = '50'
process.env.RUN_WAITING_ROWS_WRITE_MS = '400'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The stand-in: /fit answers Fit for a name after `fitDelay` ms; /read keeps each reader's body.
let fitDelay = 0
const read: string[] = []
const stand = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/fit') {
      const { n } = JSON.parse(Buffer.concat(chunks).toString()) as { n: string }
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ fit: `${n}-fit` }))
      }, fitDelay)
      return
    }
    read.push(Buffer.concat(chunks).toString())
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":"yes"}')
  })
})
await new Promise<void>(r => stand.listen(0, '127.0.0.1', r))
const port = (stand.address() as AddressInfo).port
process.env.E2E_RECEIVER_PORT = String(port)
createRequire(import.meta.url)('../e2e/net-shim.cjs')
const API = `http://api.cubex-e2e.invalid:${port}`

const { undoKit } = await import('./run-undo-kit')
const { startHttpRun } = await import('../../server/src/services/http-run-start')
const { rerunHttpColumn } = await import('../../server/src/services/http-run-rerun')
const { pauseRun, resumeRun } = await import('../../server/src/services/run-lifecycle')
const { HTTPRunJob } = await import('../../server/src/jobs/http-run-job')
const { HTTPRerunJob } = await import('../../server/src/jobs/http-rerun-job')
const { RunWaiting, parseWaitingOn } = await import('../../server/src/lib/run-waiting')
const { waitingWords, withWaiting } = await import('../../server/src/services/run-waiting-status')
const { getAiRunSummary, getHttpRunSummary } = await import('../../server/src/services/run-status')
const { aiInputGate, parkedAgain } = await import('../../server/src/services/run-input-gate')
const { db, uid, ok, done, idle, sheet } = undoKit('run-waiting')
console.error = () => {}
console.warn = () => {}

// Every write of waiting_on, and every claim (a run set running), as the database sees them.
db.exec(`CREATE TABLE t_log (run_id TEXT, what TEXT, value TEXT);
  CREATE TRIGGER t_waits AFTER UPDATE OF waiting_on ON http_runs
    BEGIN INSERT INTO t_log VALUES (NEW.id, 'write', NEW.waiting_on); END;
  CREATE TRIGGER t_claims AFTER UPDATE OF status ON http_runs WHEN NEW.status = 'running'
    BEGIN INSERT INTO t_log VALUES (NEW.id, 'claim', NULL); END;`)
const logOf = (id: string, what: string) => db.prepare('SELECT value FROM t_log WHERE run_id = ? AND what = ?')
  .pluck().all(id, what) as Array<string | null>

type Job = { name: string; args: unknown[]; seq: number; availableAt: number; state: 'waiting' | 'running' | 'done';
  snoozed: number }
let jobs: Job[] = []
createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = (cls: { name: string }) => ({
  enqueue: async (...args: unknown[]) => {
    jobs.push({ name: cls.name, args, seq: jobs.length, availableAt: 0, state: 'waiting', snoozed: 0 })
    return {}
  },
})
async function perform(j: Job): Promise<unknown> {
  if (j.name === 'HTTPRunJob') return new HTTPRunJob().run(j.args[0] as string, j.args[1] as number)
  return new HTTPRerunJob().run(j.args[0] as string, j.args[1] as number[], j.args[2] as number)
}
async function run(slots: number, until: () => boolean, timeoutMs = 20_000): Promise<void> {
  const out = new Set<Promise<void>>()
  const deadline = Date.now() + timeoutMs
  while (!until()) {
    if (Date.now() > deadline) throw new Error(`the queue got stuck: ${JSON.stringify(jobs.map(j => j.state))}`)
    for (const j of [...jobs].sort((a, b) => a.seq - b.seq)) {
      if (out.size >= slots) break
      if (j.state !== 'waiting' || j.availableAt > Date.now()) continue
      j.state = 'running'
      const p: Promise<void> = perform(j).then(r => {
        const snooze = r as { type?: string; delay?: number } | undefined
        if (snooze?.type === 'snooze') {
          j.state = 'waiting'
          j.availableAt = Date.now() + (snooze.delay ?? 0)
          j.snoozed++
        } else j.state = 'done'
      }).finally(() => out.delete(p))
      out.add(p)
    }
    await sleep(20)
  }
  await Promise.allSettled([...out])
}
const allDone = () => jobs.every(j => j.state === 'done')
const runRow = (id: string) => db.prepare('SELECT * FROM http_runs WHERE id = ?').get(id) as {
  status: string; waiting_on: string | null; worker_generation: number; user_id: string }
const NAMES = ['ada', 'bob', 'cy']

// A sheet whose Fit (from "Fit check", POST /fit with {{Name}}) is filled once.
async function scene(): Promise<string> {
  jobs = []
  fitDelay = 0
  const sid = sheet(NAMES.map(Name => ({ Name })), ['Name'])
  const out = await startHttpRun(uid, { sheetId: sid, masterColumnName: 'Fit check', allowSecrets: true, config: {
    requestConfig: { method: 'POST', url: `${API}/fit`, headers: { 'Content-Type': 'application/json' },
      body: '{"n":"{{Name}}"}' },
    responseMapping: [{ jsonPath: '$.fit', columnName: 'Fit' }], previewSize: 1 } })
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  await run(1, allDone)
  jobs = []
  return sid
}
async function reader(sid: string, name: string): Promise<string> {
  const out = await startHttpRun(uid, { sheetId: sid, masterColumnName: name, allowSecrets: true, config: {
    requestConfig: { method: 'POST', url: `${API}/read`, headers: { 'Content-Type': 'application/json' },
      body: `{"fit":"{{Fit}}","by":"${name}"}` }, responseMapping: [], previewSize: 1 } })
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  return out.ok.runId
}
async function rerunFit(sid: string): Promise<string> {
  const out = await rerunHttpColumn(uid, { sheetId: sid, masterColumnName: 'Fit check' })
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  return out.ok.runId
}

await ok('the keeper writes only when what the run waits for changes, a count at most once per interval, and '
  + 'nothing for a job a resume moved on', async () => {
  const sid = await scene()
  const r = await reader(sid, 'Keeper')
  const gen = runRow(r).worker_generation
  const k = new RunWaiting('http', r, gen, null)
  const wait = { column: 'Fit', holder: { type: 'http' as const, id: 'h1' }, hold: 'going' as const }
  k.gateWait(wait)
  k.gateWait({ ...wait })
  k.gateWait({ ...wait })
  assert.equal(k.writes, 1, 'the same wait again writes nothing')
  const since = parseWaitingOn(runRow(r).waiting_on)!.since
  assert.ok(!Number.isNaN(Date.parse(since)))
  await sleep(5)
  k.gateWait({ ...wait, parked: true })
  assert.equal(k.writes, 2)
  assert.equal(parseWaitingOn(runRow(r).waiting_on)!.parked, true)
  assert.equal(parseWaitingOn(runRow(r).waiting_on)!.since, since, 'parked, it still waits for the same: since kept')
  k.gateWait({ ...wait, holder: { type: 'http', id: 'h9' } })
  assert.notEqual(parseWaitingOn(runRow(r).waiting_on)!.since, since, 'another holder is a new wait')
  k.gateWait(null)
  assert.equal(runRow(r).waiting_on, null)
  // Rows in a lookup step: the first writes at once, more of them only after the interval, with the latest count.
  const other = { column: 'Answer', sheet_id: 's2', holder: { type: 'ai' as const, id: 'h2' }, hold: 'going' as const }
  const leaves = [k.stepWait(other)]
  const before = k.writes
  for (let i = 0; i < 5; i++) leaves.push(k.stepWait(other))
  assert.equal(k.writes, before, 'more rows inside the interval write nothing yet')
  await sleep(500)
  assert.equal(k.writes, before + 1)
  assert.equal(parseWaitingOn(runRow(r).waiting_on)!.rows, 6)
  // The gate's wait wins over rows in lookup steps.
  k.gateWait(wait)
  assert.equal(parseWaitingOn(runRow(r).waiting_on)!.column, 'Fit')
  k.gateWait(null)
  assert.equal(parseWaitingOn(runRow(r).waiting_on)!.column, 'Answer')
  for (const leave of leaves) leave()
  assert.equal(runRow(r).waiting_on, null, 'the last row out clears it at once')
  k.close()
  // A job of an older generation writes nothing.
  new RunWaiting('http', r, gen - 1, null).gateWait(wait)
  assert.equal(runRow(r).waiting_on, null)
  for (const bad of ['{', '{}', '{"column":"A","since":"x","holder":{"type":"x","id":"1"},"hold":"going"}', 'null'])
    assert.equal(parseWaitingOn(bad), null, bad)
})

await ok('the words say the column, what its run is doing and how many rows wait', async () => {
  const base = { column: 'Answer', clearing: false, rows: 120, parked: false }
  assert.equal(waitingWords({ ...base, holderStatus: 'running' }),
    'Waits for "Answer", which another run is still filling: 120 rows wait.')
  assert.equal(waitingWords({ ...base, holderStatus: 'paused' }),
    'Waits for "Answer", whose run is paused: resume or stop that run. 120 rows wait.')
  assert.equal(waitingWords({ ...base, holderStatus: 'pending', rows: 1 }),
    'Waits for "Answer", whose run is queued: 1 row waits.')
  assert.equal(waitingWords({ ...base, holderStatus: null, clearing: true }),
    'Waits for "Answer" to get back what it held before a stopped run: 120 rows wait.')
  assert.equal(waitingWords({ ...base, holderStatus: null }),
    'Waits for "Answer", whose run just ended: its rows go on in a moment.')
  assert.equal(waitingWords({ ...base, holderStatus: 'paused', parked: true }),
    'Waits for "Answer", whose run is paused: resume or stop that run. 120 rows wait. It gave its job slot back '
    + 'meanwhile.')
  assert.equal(waitingWords({ ...base, holderStatus: 'running', sheetName: 'Companies', rows: 2 }),
    'Waits for "Answer" on sheet "Companies", which a run there is still filling: 2 rows wait.')
})

await ok('behind a paused holder: the reader parks and says so, writes once in many wakes, is never claimed '
  + 'while parked, then finishes and says nothing', async () => {
  const sid = await scene()
  const r = await reader(sid, 'Waits')
  const fit = await rerunFit(sid)
  assert.deepEqual(pauseRun('http', fit, uid), { ok: true })
  jobs = jobs.filter(j => j.args[0] === r)
  const started = Date.now()
  // Many wakes: each finds the holder still paused.
  await run(1, () => (jobs[0]?.snoozed ?? 0) >= 10)
  assert.equal(runRow(r).status, 'pending')
  const s = getHttpRunSummary(r, uid)!
  assert.deepEqual({ ...s.waiting, since: undefined }, {
    column: 'Fit', held_by: { run_type: 'http', run_id: fit, column_name: 'Fit check', status: 'paused' },
    rows_waiting: 3, parked: true, since: undefined,
    message: 'Waits for "Fit", whose run is paused: resume or stop that run. 3 rows wait. It gave its job slot '
      + 'back meanwhile.',
  })
  assert.deepEqual(withWaiting([runRow(r)])[0].waiting, s.waiting, 'the app reads the same')
  const writes = logOf(r, 'write')
  assert.equal(writes.length, 1, `writes in ${jobs[0].snoozed} wakes over ${Date.now() - started} ms: `
    + JSON.stringify(writes))
  assert.equal(logOf(r, 'claim').length, 1, 'claimed once, before it first parked')
  assert.deepEqual(read.filter(b => b.includes('"Waits"')), [], 'nothing sent while the holder is paused')
  assert.deepEqual(await resumeRun('http', fit, uid, true), { ok: true })
  await run(1, allDone)
  assert.equal(runRow(r).status, 'completed')
  assert.equal(runRow(r).waiting_on, null)
  assert.equal(getHttpRunSummary(r, uid)!.waiting, undefined)
})

await ok('behind a running holder: the reader waits in place, says the holder is still filling, and ends cleared',
  async () => {
    const sid = await scene()
    const r = await reader(sid, 'InPlace')
    const fit = await rerunFit(sid)
    // The rerun's job first, so it holds Fit running when the reader looks.
    jobs.find(j => j.args[0] === fit)!.seq = -1
    fitDelay = 400
    const queue = run(2, allDone)
    let seen: ReturnType<typeof getHttpRunSummary> = null
    for (let i = 0; i < 100 && !seen?.waiting; i++) {
      await sleep(20)
      seen = getHttpRunSummary(r, uid)
    }
    assert.equal(seen?.status, 'running')
    assert.deepEqual({ ...seen!.waiting, since: undefined }, {
      column: 'Fit', held_by: { run_type: 'http', run_id: fit, column_name: 'Fit check', status: 'running' },
      rows_waiting: 3, parked: false, since: undefined,
      message: 'Waits for "Fit", which another run is still filling: 3 rows wait.',
    })
    await queue
    assert.equal(runRow(r).status, 'completed')
    assert.equal(runRow(r).waiting_on, null)
    assert.equal(logOf(r, 'write').length, 2, 'waiting, then cleared')
  })

await ok('an AI run behind a queued holder parks and says so: its waiting_on, its summary and the app list',
  async () => {
    const sid = await scene()
    const fit = await rerunFit(sid)
    const id = 'ai-waits'
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, total_rows)
      VALUES (?, ?, ?, 'Ask', 'Is /Fit good?', 'test/model', 'pending', 3)`).run(id, sid, uid)
    const aiRow = () => db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(id) as Parameters<typeof aiInputGate>[0]
    // Its job's look before the claim: Fit is held by a run still queued, so it parks.
    assert.ok((aiInputGate(aiRow(), () => false).parkedAgain() ?? 0) > 0)
    assert.deepEqual({ ...parseWaitingOn(aiRow().waiting_on), since: undefined },
      { column: 'Fit', holder: { type: 'http', id: fit }, hold: 'going', parked: true, since: undefined })
    const s = getAiRunSummary(id, uid)!
    assert.deepEqual({ ...s.waiting, since: undefined }, {
      column: 'Fit', held_by: { run_type: 'http', run_id: fit, column_name: 'Fit check', status: 'pending' },
      rows_waiting: 3, parked: true, since: undefined,
      message: 'Waits for "Fit", whose run is queued: 3 rows wait. It gave its job slot back meanwhile.',
    })
    assert.deepEqual(withWaiting([aiRow() as unknown as { status: string; user_id: string }])[0].waiting, s.waiting)
    // Woken again while the holder is still queued: it parks again, unclaimed, and writes nothing new.
    const stored = aiRow().waiting_on
    assert.ok((parkedAgain('ai', aiRow()) ?? 0) > 0)
    assert.deepEqual([aiRow().status, aiRow().waiting_on], ['pending', stored])
    db.prepare("UPDATE ai_runs SET status = 'cancelled' WHERE id = ?").run(id)
    assert.equal(getAiRunSummary(id, uid)!.waiting, undefined, 'a run that was stopped waits for nothing')
  })

stand.close()
done()

// Over 200 lines: one stand-in, one queue and the sheets serve every scene; split, each would rebuild them.
// A run whose rows wait for a run that can't go on in a job slot parks (lib/run-park.ts): it gives its slot
// back, goes back to pending and its job is snoozed, so the run it waits for gets the slot. Without that, runs
// waiting at the gate for a queued run took every slot and the queued run never started. The queue here is
// the job queue as the server runs it: the real job classes (src/jobs), a fixed number of slots, and jobs claimed
// oldest first once their time has come (as @sidequest/backend's claimPendingJob), a snoozed job keeping its
// place. HTTP requests go through Cubex's real outbound path to a stand-in (tests/e2e/net-shim.cjs).
//   - a pool of 1: a reader queued before a rerun of its input parks; the rerun runs, then the reader, and every
//     request carries the new value;
//   - a pool of 4 with 4 readers of {{Fit}} queued before Fit's rerun: every run finishes, no ⏳ goes out;
//   - a paused holder: the reader parks (a longer delay) and frees the slot, another job runs meanwhile; once the
//     holder is resumed and finishes, the reader finishes with the new values;
//   - a parked run is pending and acts as a queued one: a pause holds it (its snoozed job then does nothing), its
//     resume waits for the column like any resume, and a stop ends it with its ⏳ put back.
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// Short waits, so the scenes take seconds: read before the server's modules load.
process.env.RUN_INPUT_WAIT_POLL_MS = '100'
process.env.RUN_PARK_MS = '200'
process.env.RUN_PARK_PAUSED_MS = '400'
process.env.SIDEQUEST_POLL_MS = '50'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The stand-in: /fit answers Fit for a name, at the version the test sets (a POST: GET answers are cached);
// /read keeps each reader's body.
let version = 1
const read: string[] = []
const stand = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.pathname === '/fit') {
      const { n } = JSON.parse(Buffer.concat(chunks).toString()) as { n: string }
      res.end(JSON.stringify({ fit: `${n}-v${version}` }))
      return
    }
    read.push(Buffer.concat(chunks).toString())
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
const { pauseRun, resumeRun, cancelRun } = await import('../../server/src/services/run-lifecycle')
const { HTTPRunJob } = await import('../../server/src/jobs/http-run-job')
const { HTTPRerunJob } = await import('../../server/src/jobs/http-rerun-job')
const { db, uid, ok, done, idle, sheet, cells } = undoKit('run-park')
console.error = () => {}
console.warn = () => {}

// The queue: enqueues recorded in order; run() works them with `slots` at once.
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
}
const allDone = () => jobs.every(j => j.state === 'done')
const statusOf = (id: string) => db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(id)
const NAMES = ['ada', 'bob', 'cy']
const v = (n: number) => NAMES.map(name => `${name}-v${n}`)

// A sheet whose Fit (from "Fit check", POST /fit with {{Name}}) is filled at version 1.
async function scene(): Promise<string> {
  jobs = []
  version = 1
  const sid = sheet(NAMES.map(Name => ({ Name })), ['Name'])
  const out = await startHttpRun(uid, { sheetId: sid, masterColumnName: 'Fit check', allowSecrets: true, config: {
    requestConfig: { method: 'POST', url: `${API}/fit`, headers: { 'Content-Type': 'application/json' },
      body: '{"n":"{{Name}}"}' },
    responseMapping: [{ jsonPath: '$.fit', columnName: 'Fit' }], previewSize: 1 } })
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  await run(1, allDone)
  assert.deepEqual(cells(sid, 'Fit'), v(1))
  jobs = []
  return sid
}
// A reader of {{Fit}}, queued.
async function reader(sid: string, name: string): Promise<string> {
  const out = await startHttpRun(uid, { sheetId: sid, masterColumnName: name, allowSecrets: true, config: {
    requestConfig: { method: 'POST', url: `${API}/read`, headers: { 'Content-Type': 'application/json' },
      body: `{"fit":"{{Fit}}","by":"${name}"}` }, responseMapping: [], previewSize: 1 } })
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  return out.ok.runId
}
// Fit run again at version 2, queued behind the readers.
async function rerunFit(sid: string): Promise<string> {
  version = 2
  const out = await rerunHttpColumn(uid, { sheetId: sid, masterColumnName: 'Fit check' })
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  return out.ok.runId
}
const fitsSent = (by: string) => read.map(b => JSON.parse(b) as { fit: string; by: string })
  .filter(b => b.by === by).map(b => b.fit).sort()

await ok('a pool of 1: a reader queued before a rerun of its input parks, the rerun runs, then the reader; '
  + 'every request carries the new value', async () => {
  const sid = await scene()
  const r = await reader(sid, 'Read')
  const fit = await rerunFit(sid)
  await run(1, allDone)
  assert.equal(statusOf(fit), 'completed')
  assert.equal(statusOf(r), 'completed')
  assert.deepEqual(fitsSent('Read'), v(2))
  assert.ok(jobs[0].snoozed >= 1, 'the reader parked')
  assert.ok(read.every(b => !b.includes('⏳')))
})

await ok('a pool of 4: four readers of {{Fit}} queued, then a rerun of Fit: every run finishes, no ⏳ goes out',
  async () => {
    const sid = await scene()
    const readers = []
    for (const name of ['R1', 'R2', 'R3', 'R4']) readers.push(await reader(sid, name))
    const fit = await rerunFit(sid)
    await run(4, allDone)
    assert.deepEqual([fit, ...readers].map(statusOf), Array(5).fill('completed'))
    for (const name of ['R1', 'R2', 'R3', 'R4']) assert.deepEqual(fitsSent(name), v(2), name)
    assert.ok(read.every(b => !b.includes('⏳')))
  })

await ok('a paused holder: the reader parks and frees the slot (another job runs meanwhile); once the holder is '
  + 'resumed and finishes, the reader finishes with the new values', async () => {
  const sid = await scene()
  const r = await reader(sid, 'Waits')
  const fit = await rerunFit(sid)
  assert.deepEqual(pauseRun('http', fit, uid), { ok: true })
  jobs = jobs.filter(j => j.args[0] === r)
  const other = await reader(sheet([{ Name: 'zed', Fit: 'z' }], ['Name', 'Fit']), 'Other')
  await run(1, () => statusOf(other) === 'completed')
  assert.equal(statusOf(r), 'pending', 'the reader is parked')
  assert.equal(statusOf(fit), 'paused')
  assert.deepEqual(fitsSent('Waits'), [], 'nothing sent while the holder is paused')
  assert.deepEqual(await resumeRun('http', fit, uid, true), { ok: true })
  await run(1, allDone)
  assert.equal(statusOf(fit), 'completed')
  assert.equal(statusOf(r), 'completed')
  assert.deepEqual(fitsSent('Waits'), v(2))
})

await ok('a parked run acts as a queued one: a pause holds it and its snoozed job then does nothing, its resume '
  + 'waits for the column, and a stop ends it with its ⏳ put back', async () => {
  const sid = await scene()
  const r = await reader(sid, 'Parked')
  await rerunFit(sid)
  const stuck = new Promise((_, reject) => setTimeout(() => reject(new Error('it never parked')), 5_000))
  const parked = await Promise.race([new HTTPRunJob().run(r, 0), stuck]) as { type?: string } | undefined
  assert.equal(parked?.type, 'snooze')
  assert.equal(statusOf(r), 'pending')
  assert.deepEqual(pauseRun('http', r, uid), { ok: true })
  assert.equal(await new HTTPRunJob().run(r, 0), undefined, 'the snoozed job wakes to a paused run')
  assert.equal(statusOf(r), 'paused')
  assert.deepEqual(await resumeRun('http', r, uid, true), { fail: 'held', message: 'The request reads "Fit", which '
    + 'a run that hasn\'t finished is still filling. Wait for that run to finish (or stop it), then try again.' })
  assert.deepEqual(await cancelRun('http', r, uid), { ok: true })
  while (db.prepare('SELECT placeholder_work FROM http_runs WHERE id = ?').pluck().get(r) !== null) await sleep(10)
  assert.equal(statusOf(r), 'cancelled')
  assert.deepEqual(cells(sid, 'Parked'), ['', '', ''])
  assert.deepEqual(fitsSent('Parked'), [])
})

stand.close()
done()

// AI runs queued through the insert worker (server/src/lib/job-inserts.ts) with each insert held, as a slow disk
// would, through the real queue helpers (queue.ts), run controls and AI runner against a stand-in for the provider;
// each job is claimed from jobs.db and run here, as the queue's process would:
//   - a run left alone: its job does its calls and completes it (the control);
//   - a run stopped, or paused, before its job's insert lands: that job, claimed once it lands, makes no call, and
//     the run stays cancelled or paused;
//   - a stop the held insert outlasts: the run stays pending with no job; the next start queues it again at a new
//     generation, and that job completes it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'
import type * as SidequestTypes from 'sidequest'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-inserts-runs-'))
const file = path.join(dir, 'jobs.db')
process.env.JOBS_DB_PATH = file
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let calls = 0
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    calls++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id: 'gen-1', object: 'chat.completion', created: 0, model: 'test/model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.0001 },
    }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest') as typeof SidequestTypes
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { encrypt } = await import('../../server/src/lib/crypto')
const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
const { jobsDbInWal } = await import('../../server/src/lib/jobs-db')
const { startJobInserts, closeJobInserts, setJobInsertsForTests } = await import('../../server/src/lib/job-inserts')
const { enqueueAIRun, resumeRecoveredRuns } = await import('../../server/src/queue')
const { cancelRun, pauseRun } = await import('../../server/src/services/run-lifecycle')
const { resetOrphanedRuns } = await import('../../server/src/lib/orphan-runs')
const { AIRunJob } = await import('../../server/src/jobs/ai-run-job')
runMigrations()
const errors: string[] = []
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')) }
console.warn = () => {}
let failures = 0
const ok = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
  .run(uuid(), uid, encrypt('sk-or-test'))
const OUT = 'Hi (Output)'
// A sheet of 3 rows waiting on a run (their output cell ⏳), and that run, pending.
const runOf = () => {
  const sid = uuid(), runId = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(sid, tid, uid, `S-${sid.slice(0, 6)}`, JSON.stringify(['name', OUT]))
  for (let i = 0; i < 3; i++) {
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(uuid(), sid, uid, i, JSON.stringify({ name: `N${i}`, [OUT]: PLACEHOLDER }))
  }
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows)
    VALUES (?,?,?,?,'Say hi to /name','test/model',1,'pending',3)`).run(runId, sid, uid, OUT)
  return runId
}
const run = (id: string) => db.prepare('SELECT status, worker_generation AS generation FROM ai_runs WHERE id = ?')
  .get(id) as { status: string; generation: number }
// The run's jobs, claimed from jobs.db as the queue's process does, and each run as its thread would.
async function claimedJobs(runId: string): Promise<unknown[][]> {
  const jobs = await Sidequest.getBackend()!.claimPendingJob('default', 100)
  return jobs.map(j => j.args as unknown[]).filter(a => a[0] === runId)
}
const work = async (args: unknown[]) => { await new AIRunJob().run(args[0] as string, args[1] as number) }

assert.equal(await jobsDbInWal(file), 'wal')
await Sidequest.configure({ backend: { driver: '@sidequest/sqlite-backend', config: file }, manualJobResolution: true,
  jobsFilePath: path.resolve('sidequest.jobs.cjs') })
startJobInserts(file)

await ok('a run left alone: its job, inserted on the worker, does its calls and completes it', async () => {
  setJobInsertsForTests({ delayMs: 200 })
  const id = runOf()
  await enqueueAIRun(id)
  const jobs = await claimedJobs(id)
  assert.equal(jobs.length, 1)
  const before = calls
  await work(jobs[0])
  assert.equal(calls - before, 3)
  assert.equal(run(id).status, 'completed')
})

for (const [control, status] of [['a stop', 'cancelled'], ['a pause', 'paused']] as const) {
  await ok(`${control} before the job's insert lands: the job, claimed later, makes no call`, async () => {
    setJobInsertsForTests({ delayMs: 300 })
    const id = runOf()
    const queued = enqueueAIRun(id)
    await sleep(30)
    const out = status === 'cancelled' ? await cancelRun('ai', id, uid) : pauseRun('ai', id, uid)
    assert.deepEqual(out, { ok: true })
    assert.equal(run(id).status, status)
    await queued
    const jobs = await claimedJobs(id)
    assert.equal(jobs.length, 1, 'the insert landed after the control')
    const before = calls
    await work(jobs[0])
    assert.equal(calls, before)
    assert.equal(run(id).status, status)
  })
}

await ok('a stop the held insert outlasts: the run stays pending; the next start queues and completes it', async () => {
  setJobInsertsForTests({ delayMs: 1500, drainMs: 200 })
  const id = runOf()
  const generation = run(id).generation
  const queued = enqueueAIRun(id)
  await sleep(30)
  errors.length = 0
  await closeJobInserts()
  await queued
  assert.match(errors.join('\n'), /didn't finish within 200 ms/)
  assert.deepEqual(run(id), { status: 'pending', generation })
  assert.deepEqual(await claimedJobs(id), [])

  // The next start, as server-lifecycle.ts makes it.
  setJobInsertsForTests({ delayMs: 0, drainMs: 5000 })
  const recovered = resetOrphanedRuns()
  assert.deepEqual(recovered.aiRunIds, [id])
  startJobInserts(file)
  await resumeRecoveredRuns(recovered)
  const jobs = await claimedJobs(id)
  assert.deepEqual(jobs, [[id, generation + 1]])
  const before = calls
  await work(jobs[0])
  assert.equal(calls - before, 3)
  assert.equal(run(id).status, 'completed')
})

await closeJobInserts()
await Sidequest.stop()
server.close()
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
process.exit(0)

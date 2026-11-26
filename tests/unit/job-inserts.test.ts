// Jobs inserted into the job queue's database from a worker thread (server/src/lib/job-inserts.ts), on a real
// jobs.db in WAL mode that the queue library set up on this thread, as the server has it:
//   - a job queued through it has the columns the library's own enqueue gives;
//   - no statement on jobs.db runs on this thread while jobs are queued, including the first insert after another
//     connection's full checkpoint (the WAL started over, its header synced); the library's own enqueue does;
//   - jobs queued back to back, each insert held, are inserted and claimed in the order queued;
//   - stopping waits for the inserts already asked, which land; one past the drain time counts as queued (the
//     runs test shows its run is queued again at the next start); a queue call once stopping began fails;
//   - a worker that can't start: logged once, the jobs inserted on this thread instead, in order;
//   - a worker that stops with inserts waiting: they're made on this thread, in order, and later ones too.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import type BetterSqlite from 'better-sqlite3'
import type * as SidequestTypes from 'sidequest'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const req = createRequire(path.resolve('server/src/queue.ts'))
const Database = req('better-sqlite3') as typeof BetterSqlite
const { Job, Sidequest } = req('sidequest') as typeof SidequestTypes
const { jobsDbInWal } = await import('../../server/src/lib/jobs-db')
const inserts = await import('../../server/src/lib/job-inserts')
const { enqueueJob, startJobInserts, closeJobInserts, jobInsertsOnWorker, setJobInsertsForTests } = inserts
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const errors: string[] = []
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')) }
let failures = 0
const ok = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

class StubJob extends Job { async run(_runId: string, _generation: number): Promise<unknown> { return undefined } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-inserts-'))
const file = path.join(dir, 'jobs.db')
// As queue.ts startQueue: WAL first, then the library on this thread (Cubex's settings: no job defaults).
assert.equal(await jobsDbInWal(file), 'wal')
await Sidequest.configure({ backend: { driver: '@sidequest/sqlite-backend', config: file }, manualJobResolution: true,
  jobsFilePath: path.resolve('sidequest.jobs.cjs') })
const reader = new Database(file, { readonly: true })
type Row = Record<string, unknown> & { id: number; args: string }
const rows = (prefix: string) => (reader.prepare('SELECT * FROM sidequest_jobs ORDER BY id').all() as Row[])
  .filter(r => (JSON.parse(r.args) as unknown[])[0]?.toString().startsWith(prefix))
const firstArgs = (prefix: string) => rows(prefix).map(r => (JSON.parse(r.args) as unknown[])[0])

// Every statement on jobs.db this thread prepares or runs while `watching`.
const seen: string[] = []
let watching = false
const proto = Database.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
for (const m of ['prepare', 'exec', 'pragma']) {
  const own = proto[m]
  proto[m] = function (this: { name: string }, ...a: unknown[]) {
    if (watching && path.resolve(this.name) === path.resolve(file)) seen.push(`${m}: ${String(a[0]).slice(0, 80)}`)
    return own.apply(this, a)
  }
}

await ok('a job queued through the worker has the columns the library\'s own enqueue gives', async () => {
  const t0 = Date.now()
  await Sidequest.build(StubJob).enqueue('lib', 1)
  startJobInserts(file)
  assert.ok(jobInsertsOnWorker())
  await enqueueJob(StubJob, 'ours', 1)
  const [lib] = rows('lib'), [ours] = rows('ours')
  for (const key of Object.keys(lib)) {
    if (['id', 'args', 'inserted_at', 'available_at'].includes(key)) continue
    assert.deepEqual(ours[key], lib[key], key)
  }
  assert.deepEqual(JSON.parse(ours.args), ['ours', 1])
  for (const key of ['inserted_at', 'available_at']) {
    const v = ours[key], at = typeof v === 'number' ? v : new Date(String(v)).getTime()
    assert.ok(at >= t0 - 1000 && at <= Date.now() + 1000, `${key} ${String(ours[key])}`)
  }
})

await ok('no statement on jobs.db runs on this thread while queuing, after a full checkpoint too', async () => {
  watching = true
  await Sidequest.build(StubJob).enqueue('probe', 0)
  watching = false
  assert.ok(seen.length > 0, 'the watch sees the library\'s own enqueue on this thread')
  seen.length = 0
  watching = true
  for (let i = 0; i < 5; i++) await enqueueJob(StubJob, `main${i}`, i)
  watching = false
  const other = new Database(file)
  other.pragma('wal_checkpoint(TRUNCATE)')
  other.close()
  assert.equal(fs.statSync(`${file}-wal`).size, 0, 'the WAL starts over with the next commit')
  watching = true
  await enqueueJob(StubJob, 'main5', 5)
  watching = false
  assert.ok(fs.statSync(`${file}-wal`).size > 0)
  assert.deepEqual(seen, [])
  assert.deepEqual(firstArgs('main'), ['main0', 'main1', 'main2', 'main3', 'main4', 'main5'])
})

await ok('jobs queued back to back, each insert held, are inserted and claimed in the order queued', async () => {
  setJobInsertsForTests({ delayMs: 30 })
  await Promise.all([0, 1, 2, 3, 4, 5].map(i => enqueueJob(StubJob, `order${i}`, i)))
  setJobInsertsForTests({ delayMs: 0 })
  const queued = ['order0', 'order1', 'order2', 'order3', 'order4', 'order5']
  assert.deepEqual(firstArgs('order'), queued)
  const claimed = await Sidequest.getBackend()!.claimPendingJob('default', 100)
  assert.deepEqual(claimed.map(j => (j.args as unknown[])[0]).filter(a => String(a).startsWith('order')), queued)
})

await ok('a stop waits for the inserts asked; one past the drain counts as queued; later calls fail', async () => {
  setJobInsertsForTests({ delayMs: 150 })
  const asked = [0, 1, 2].map(i => enqueueJob(StubJob, `drain${i}`, i))
  await sleep(20)
  errors.length = 0
  await closeJobInserts()
  await Promise.all(asked)
  assert.deepEqual(firstArgs('drain'), ['drain0', 'drain1', 'drain2'])
  assert.deepEqual(errors, [])
  await assert.rejects(enqueueJob(StubJob, 'late', 0), /stopping/)
  assert.equal(rows('late').length, 0)

  startJobInserts(file)
  setJobInsertsForTests({ delayMs: 1500, drainMs: 200 })
  const slow = enqueueJob(StubJob, 'slow', 0)
  await sleep(20)
  await closeJobInserts()
  await slow
  assert.equal(rows('slow').length, 0)
  assert.equal(errors.length, 1, errors.join('\n'))
  assert.match(errors[0], /didn't finish within 200 ms/)
  setJobInsertsForTests({ delayMs: 0, drainMs: 5000 })
})

await ok('a worker that can\'t start: logged once, the jobs inserted on this thread in order', async () => {
  inserts.resetJobInsertsForTests()
  setJobInsertsForTests({ workerFile: path.join(dir, 'missing.js') })
  errors.length = 0
  startJobInserts(file)
  await Promise.all([0, 1].map(i => enqueueJob(StubJob, `nowork${i}`, i)))
  await enqueueJob(StubJob, 'nowork2', 2)
  assert.equal(jobInsertsOnWorker(), false)
  assert.deepEqual(firstArgs('nowork'), ['nowork0', 'nowork1', 'nowork2'])
  assert.equal(errors.filter(e => /insert worker/.test(e)).length, 1, errors.join('\n'))
  await closeJobInserts()
  inserts.resetJobInsertsForTests()
  setJobInsertsForTests({ workerFile: null })
})

await ok('a worker that stops with inserts waiting: made on this thread in order, and later ones too', async () => {
  startJobInserts(file)
  assert.ok(jobInsertsOnWorker())
  setJobInsertsForTests({ delayMs: 300 })
  const asked = [0, 1, 2].map(i => enqueueJob(StubJob, `crash${i}`, i))
  await sleep(30)
  errors.length = 0
  await inserts.stopJobInsertWorkerForTests()
  await Promise.all(asked)
  await enqueueJob(StubJob, 'crash3', 3)
  assert.equal(jobInsertsOnWorker(), false)
  assert.deepEqual(firstArgs('crash'), ['crash0', 'crash1', 'crash2', 'crash3'])
  assert.equal(errors.filter(e => /insert worker stopped/.test(e)).length, 1, errors.join('\n'))
  await closeJobInserts()
})

reader.close()
await Sidequest.stop()
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
passed()

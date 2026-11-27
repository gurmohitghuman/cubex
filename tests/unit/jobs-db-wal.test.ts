// The job queue's database (jobs.db) switched to WAL mode before the queue opens it (server/src/lib/jobs-db.ts), on
// files made the way every install made them so far: by the queue library's own setup, which leaves a file in its
// rollback journal mode (checked here, since the switch exists for it).
//   - waiting, claimed, running and completed jobs all come through unchanged; a new connection gets WAL with
//     synchronous=NORMAL, and the queue still claims the waiting job;
//   - a transaction another process left unfinished when it died (a hot journal) is rolled back first, and the
//     rows from before it are kept;
//   - another process writing to the file: the switch waits for it, the loop free, and switches once it's done;
//     held past the wait, the old mode stays, logged, rows unchanged, and the next start switches;
//   - a file already in WAL mode is not written.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const SqliteBackend = req('@sidequest/sqlite-backend').default as new (file: string) => SidequestTypes.Backend
const { Job, JobBuilder } = req('sidequest') as typeof SidequestTypes
const SQLITE = req.resolve('better-sqlite3')
const { jobsDbInWal } = await import('../../server/src/lib/jobs-db')
const { JOBS_DB_SWITCH_WAIT_MS } = await import('../../server/src/lib/constants')

const errors: string[] = []
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')) }
let failures = 0
const ok = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

class StubJob extends Job { async run(_runId: string, _generation: number): Promise<unknown> { return undefined } }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-db-'))
// A jobs.db as the library sets one up, with a job in each state the queue leaves them in between starts.
async function made(name: string): Promise<string> {
  const file = path.join(dir, `${name}.db`)
  const backend = new SqliteBackend(file)
  await backend.migrate()
  for (let i = 0; i < 4; i++) await new JobBuilder(backend, StubJob, undefined, true).enqueue(`run-${i}`, i)
  const [running, done, claimed] = await backend.claimPendingJob('default', 3)
  await backend.updateJob({ id: running.id, state: 'running', attempted_at: new Date(), attempt: 1 })
  await backend.updateJob({ id: done.id, state: 'completed', completed_at: new Date(), result: 'done' })
  assert.equal(claimed.state, 'claimed')
  await backend.close()
  return file
}
// Every table's rows, and the mode the file is in.
function dump(file: string): { mode: string; tables: Record<string, unknown[]> } {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck()
      .all() as string[]
    const tables = Object.fromEntries(names.map(n => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]))
    return { mode: String(db.pragma('journal_mode', { simple: true })), tables }
  } finally { db.close() }
}
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
// Another process with a connection to `file`, running `code` (`db` is its connection); it prints `ready` once
// done, then does what `release` says when it gets a line on stdin.
function holder(file: string, code: string, release = ''): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `const D = require(process.argv[1]); const db = new D(process.argv[2]);
    ${code}; process.stdout.write('ready\\n');
    process.stdin.once('data', () => { ${release}; process.stdout.write('released\\n'); process.exit(0) })`,
  SQLITE, file], { stdio: ['pipe', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    child.stdout!.once('data', b => String(b).includes('ready') ? resolve(child) : reject(new Error(String(b))))
    child.once('exit', code => reject(new Error(`the holder exited (${code})`)))
  })
}
const exited = (child: ChildProcess) => new Promise(r => {
  if (child.exitCode !== null || child.signalCode) r(0); else child.once('exit', r)
})

await ok('a new jobs.db is in rollback mode; the switch keeps every row, and the queue claims on', async () => {
  const file = await made('switch')
  const before = dump(file)
  assert.equal(before.mode, 'delete')
  assert.deepEqual(before.tables.sidequest_jobs.map(j => (j as { state: string }).state).sort(),
    ['claimed', 'completed', 'running', 'waiting'])
  assert.equal(await jobsDbInWal(file), 'wal')
  const after = dump(file)
  assert.equal(after.mode, 'wal')
  assert.deepEqual(after.tables, before.tables)
  const db = new Database(file)
  assert.equal(db.pragma('synchronous', { simple: true }), 1, 'synchronous=NORMAL on a new connection')
  db.close()
  const backend = new SqliteBackend(file)
  const claimed = await backend.claimPendingJob('default', 5)
  await backend.close()
  assert.deepEqual(claimed.map(j => j.args), [['run-3', 3]])
})

await ok('a transaction a dead process left unfinished is rolled back, the rows from before kept', async () => {
  const file = await made('hot')
  const before = dump(file)
  const size = fs.statSync(file).size
  const child = await holder(file, `db.pragma('cache_size = 1'); db.exec('BEGIN');
    db.prepare("UPDATE sidequest_jobs SET args = '[\\"gone\\"]'").run(); db.exec('CREATE TABLE junk (x)');
    const add = db.prepare('INSERT INTO junk VALUES (?)'); for (let i = 0; i < 2000; i++) add.run('x'.repeat(2000))`)
  assert.ok(fs.statSync(file).size > size, 'the unfinished transaction already wrote to the file')
  assert.ok(fs.statSync(`${file}-journal`).size > 0, 'with its journal next to it')
  child.kill('SIGKILL')
  await exited(child)
  assert.equal(await jobsDbInWal(file), 'wal')
  const after = dump(file)
  assert.equal(after.mode, 'wal')
  assert.deepEqual(after.tables, before.tables)
  assert.equal(fs.existsSync(`${file}-journal`), false)
})

const writing = (file: string) => holder(file,
  `db.exec('BEGIN IMMEDIATE'); db.prepare("UPDATE sidequest_jobs SET result = 'x'").run()`,
  `db.exec('ROLLBACK'); db.close()`)

await ok('another process writing: the switch waits for it with the loop free, then switches', async () => {
  const file = await made('busy')
  const before = dump(file)
  const child = await writing(file)
  errors.length = 0
  let ticks = 0
  const tick = setInterval(() => { ticks++ }, 20)
  setTimeout(() => child.stdin!.write('go\n'), 500)
  const t0 = Date.now()
  const mode = await jobsDbInWal(file)
  const took = Date.now() - t0
  clearInterval(tick)
  await exited(child)
  assert.equal(mode, 'wal')
  assert.ok(took >= 450 && took < JOBS_DB_SWITCH_WAIT_MS, `it switched ${took} ms in, once the writer was done`)
  assert.ok(ticks >= 10, `the loop ran meanwhile (${ticks} ticks)`)
  assert.deepEqual(errors, [])
  assert.deepEqual(dump(file).tables, before.tables)
})

await ok('another process writing past the wait: the old mode stays, logged, and the next start switches', async () => {
  const file = await made('held')
  const before = dump(file)
  const child = await writing(file)
  errors.length = 0
  const t0 = Date.now()
  const mode = await jobsDbInWal(file)
  assert.equal(mode, null)
  assert.ok(Date.now() - t0 >= JOBS_DB_SWITCH_WAIT_MS, `it waited ${Date.now() - t0} ms first`)
  assert.equal(errors.length, 1, errors.join('\n'))
  assert.match(errors[0], /WAL/)
  child.stdin!.write('go\n')
  await exited(child)
  assert.deepEqual(dump(file), before)
  assert.equal(await jobsDbInWal(file), 'wal')
  assert.deepEqual(dump(file).tables, before.tables)
})

await ok('a file already in WAL mode is not written', async () => {
  const file = await made('again')
  assert.equal(await jobsDbInWal(file), 'wal')
  const was = hash(file), mtime = fs.statSync(file).mtimeMs
  errors.length = 0
  assert.equal(await jobsDbInWal(file), 'wal')
  assert.equal(hash(file), was)
  assert.equal(fs.statSync(file).mtimeMs, mtime)
  assert.deepEqual(errors, [])
})

if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
passed()

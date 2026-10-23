// bin/cubex-backup.mjs, the copy of the data an update keeps (install.sh,
// install.ps1, cubex rollback), on files in the test's own temp folder: a first
// install has nothing to copy (exit 4); save copies the database and jobs.db
// with their -wal, -shm and -journal files (owner-only); info reads the copy;
// restore moves the newer files into a new replaced-<time> folder and the copy
// into place; one stopped partway goes on from where it stopped, never moving
// the copy aside; a second restore finds no copy; an earlier replaced folder is
// never deleted.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
let failures = 0
const ok = (label: string, fn: () => void) => {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const SCRIPT = path.join(process.cwd(), 'bin', 'cubex-backup.mjs')
const dir = fs.mkdtempSync(path.join(path.dirname(process.env.DB_PATH), 'update-backup-'))
const db = path.join(dir, 'cubex.db'), jobs = path.join(dir, 'jobs.db')
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
const read = (f: string) => fs.readFileSync(f, 'utf8')
const backups = path.join(dir, 'backups'), slot = path.join(backups, 'before-update')
const replaced = () => fs.readdirSync(backups).filter(n => n.startsWith('replaced-')).sort()
const write = (files: Record<string, string>) => { for (const [f, v] of Object.entries(files)) fs.writeFileSync(f, v) }

ok('a first install has nothing to copy', () => {
  assert.equal(run('save', db, jobs, 'v1').status, 4)
  assert.ok(!fs.existsSync(slot))
  assert.equal(run('info', db).status, 3)
})

write({ [db]: 'db v1', [`${db}-wal`]: 'wal v1', [jobs]: 'jobs v1', [`${jobs}-journal`]: 'journal v1' })

ok('save copies the database and jobs.db with their WAL and journal files, owner-only', () => {
  const r = run('save', db, jobs, 'v0.6.1 abc1234')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(path.join(slot, 'cubex.db')), 'db v1')
  assert.equal(read(path.join(slot, 'cubex.db-wal')), 'wal v1')
  assert.equal(read(path.join(slot, 'jobs.db')), 'jobs v1')
  assert.equal(read(path.join(slot, 'jobs.db-journal')), 'journal v1')
  assert.ok(!fs.existsSync(path.join(slot, 'cubex.db-shm')), 'only the files there are')
  assert.ok(!fs.existsSync(`${slot}.tmp`), 'nothing left behind')
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(slot, 'cubex.db')).mode & 0o777, 0o600)
  const info = JSON.parse(run('info', db).stdout)
  assert.equal(info.version, 'v0.6.1 abc1234')
  assert.ok(!Number.isNaN(Date.parse(info.at)))
})

// The new version migrates: its files differ from the copy.
fs.rmSync(`${db}-wal`); fs.rmSync(`${jobs}-journal`)
write({ [db]: 'db v2', [`${db}-shm`]: 'shm v2', [jobs]: 'jobs v2', [`${jobs}-journal`]: 'journal v2' })

ok('restore moves the newer files aside and the copy into place', () => {
  const r = run('restore', db, jobs)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(db), 'db v1')
  assert.equal(read(`${db}-wal`), 'wal v1')
  assert.ok(!fs.existsSync(`${db}-shm`), "the newer database's -shm doesn't stay beside the older one")
  assert.equal(read(jobs), 'jobs v1')
  assert.equal(read(`${jobs}-journal`), 'journal v1', "the newer jobs.db's journal never replays onto the older one")
  const [aside] = replaced()
  assert.equal(read(path.join(backups, aside, 'cubex.db')), 'db v2')
  assert.equal(read(path.join(backups, aside, 'jobs.db-journal')), 'journal v2')
  assert.ok(!fs.existsSync(slot), 'the copy is used up')
})

ok('a second restore finds no copy and changes nothing', () => {
  assert.equal(run('restore', db, jobs).status, 3)
  assert.equal(read(db), 'db v1')
})

ok('a restore stopped partway goes on from there; an earlier replaced folder stays', () => {
  const earlier = replaced()
  assert.equal(run('save', db, jobs, 'v1').status, 0)
  write({ [db]: 'db v3', [jobs]: 'jobs v3' })
  // As if the last run stopped after moving the live files aside and one file of the copy in.
  const aside = 'replaced-2026-10-20T00-00-00-000Z'
  fs.mkdirSync(path.join(backups, aside))
  fs.renameSync(db, path.join(backups, aside, 'cubex.db'))
  fs.renameSync(jobs, path.join(backups, aside, 'jobs.db'))
  fs.renameSync(path.join(slot, 'cubex.db'), db)
  fs.writeFileSync(path.join(slot, 'restoring.json'), JSON.stringify({ aside, stage: 'in' }))
  const r = run('restore', db, jobs)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(read(db), 'db v1')
  assert.equal(read(jobs), 'jobs v1')
  assert.equal(read(path.join(backups, aside, 'cubex.db')), 'db v3', 'the newer data stays where it was put')
  assert.ok(!fs.existsSync(slot))
  assert.deepEqual(replaced(), [...earlier, aside].sort(), 'no replaced folder was deleted')
})

fs.rmSync(dir, { recursive: true, force: true })
if (failures) { console.error(`${failures} update-backup assertion(s) failed`); process.exit(1) }
console.log('All update-backup assertions passed.')

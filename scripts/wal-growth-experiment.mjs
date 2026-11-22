// Experiment (removed before review): does a plain WAL commit wait on the OS only while it grows the -wal file?
// Rounds of 100 slices of 500 new rows each (about 107 WAL frames, as hiring-summarize-big's first pass), with the
// server's pragmas, in three ways the -wal file can be before the slices: grown from empty (as after the test
// probe's TRUNCATE, or a server start), already that size with zeros written and synced (preallocated), or only
// set to that size (end of file moved, nothing written). Prints each way's commit times and its commits that took
// 40 ms or more off the CPU.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const ROUNDS = Number(process.env.WAL_ROUNDS ?? 30)
const SLICES = 100
const ROWS = 500
const PREALLOC = 64 * 1024 * 1024
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walx-'))
const file = path.join(dir, 'x.db')
const wal = `${file}-wal`
const db = new Database(file)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('secure_delete = ON')
db.pragma('busy_timeout = 5000')
db.pragma('cache_size = -64000')
db.pragma(`mmap_size = ${process.platform === 'win32' ? 0 : 268435456}`)
db.pragma('temp_store = MEMORY')
db.pragma(`journal_size_limit = ${64 * 1024 * 1024}`)
db.pragma('wal_autocheckpoint = 0')
db.exec(`CREATE TABLE rows (id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, row_index INTEGER NOT NULL, data TEXT);
  CREATE INDEX rows_sheet ON rows (sheet_id, row_index)`)
const insert = db.prepare('INSERT INTO rows (id, sheet_id, row_index, data) VALUES (?, ?, ?, ?)')
let next = 0
// Ids in order, as orderedUuid's are: each slice's new index entries sit together.
// About 800 bytes of cells a row, so a slice writes about 107 frames, as the test's first pass does.
const links = (n) => Array.from({ length: 4 }, (_, i) => `https://jobs.example/${n}/${i}/a-longer-posting-path`)
const row = (sheet) => insert.run(String(next).padStart(12, '0'), sheet, next++, JSON.stringify({
  Company: `Company ${next}`, Domain: `c${next}.com`, 'Open roles': '4', 'First seen': '2026-11-11',
  Titles: 'SDR, BDR, Account Executive, Sales Engineer, CSM, RevOps Analyst, VP Sales', Links: links(next).join(' '),
  'Newest posting': '2026-05-15', 'New since': '2026-11-04', 'New roles': 'SDR (Austin, TX), BDR (Austin, TX)' }))
const t0 = performance.now()
db.transaction(() => { for (let i = 0; i < 200_000; i++) row('roles') }).immediate()
console.log(`seeded 200,000 rows in ${((performance.now() - t0) / 1000).toFixed(1)} s`)

const frames = () => db.pragma('wal_checkpoint(NOOP)')[0].log
function prepare(way) {
  db.pragma('wal_checkpoint(TRUNCATE)')
  if (way !== 'grown') {
    const fd = fs.openSync(wal, 'r+')
    if (way === 'zeroed') {
      const mb = Buffer.alloc(1024 * 1024)
      for (let at = 0; at < PREALLOC; at += mb.length) fs.writeSync(fd, mb, 0, mb.length, at)
    } else fs.ftruncateSync(fd, PREALLOC)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
  }
  // As the probe and a worker's start-over do: the WAL begun with one small write.
  db.pragma(`user_version = ${Number(db.pragma('user_version', { simple: true }))}`)
}
const ways = ['grown', 'zeroed', 'sized']
const seen = Object.fromEntries(ways.map(w => [w, { ms: [], slow: [], sizeAfter: 0, frames: 0 }]))
for (let r = 0; r < ROUNDS; r++) {
  for (const way of [...ways.slice(r % 3), ...ways.slice(0, r % 3)]) {
    prepare(way)
    for (let s = 0; s < SLICES; s++) {
      const f0 = frames()
      const c0 = process.threadCpuUsage()
      const a = performance.now()
      db.transaction(() => { for (let i = 0; i < ROWS; i++) row('companies') }).immediate()
      const ms = performance.now() - a
      const c = process.threadCpuUsage(c0)
      const cpu = (c.user + c.system) / 1000
      seen[way].ms.push(ms)
      const line = `r${r} s${s} ${ms.toFixed(1)} ms (cpu ${cpu.toFixed(1)}) WAL ${f0}->${frames()}`
      if (ms - cpu >= 40) seen[way].slow.push(line)
    }
    seen[way].sizeAfter = fs.statSync(wal).size
    seen[way].frames = frames()
  }
}
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]
for (const way of ways) {
  const { ms, slow, sizeAfter, frames: f } = seen[way]
  console.log(`${way}: ${ms.length} commits, median ${q(ms, 0.5).toFixed(1)} ms, p99 ${q(ms, 0.99).toFixed(1)} ms, `
    + `max ${Math.max(...ms).toFixed(1)} ms; ${slow.length} took 40 ms or more off the CPU; `
    + `-wal ${(sizeAfter / 1048576).toFixed(1)} MB, ${f} frames after a round`)
  for (const l of slow.slice(0, 40)) console.log(`  ${l}`)
}
db.close()
fs.rmSync(dir, { recursive: true, force: true })

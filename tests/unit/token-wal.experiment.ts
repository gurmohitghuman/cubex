// Experiment (removed before review): token-last-used's lock case, repeated, with the -wal file growing or made its
// full size first. Each round: a new token; another connection takes the write lock; a use is noted and its write
// refused; HOLD_MS later the lock is let go, and the write lands on its retry. Growing: the WAL is emptied first
// (wal_checkpoint(TRUNCATE)), so the other connection's commit and then the write both add past the file's end, as
// after the test's migrations. Sized: the file is made its full size at the start of each block, as a Windows server
// does at start. The ways take turns by blocks of BLOCK rounds. Prints every landing write that spent 40 ms or more
// off the CPU, then each way's totals.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import type BetterSqlite from 'better-sqlite3'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const DB_PATH = process.env.DB_PATH
const Database = createRequire(path.resolve('server/src/queue.ts'))('better-sqlite3') as typeof BetterSqlite
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { generateAccessToken } = await import('../../server/src/lib/access-token')
const { noteTokenUse } = await import('../../server/src/lib/token-last-used')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
const { setWalFileSizingForTests, sizeWalFile } = await import('../../server/src/lib/wal-file')
const { sqliteWriteProbe, transactionLine } = await import('./sqlite-write-probe')
runMigrations()
console.error = () => {}
setWalFileSizingForTests(true)
const probe = sqliteWriteProbe(db, DB_PATH)

const ROUNDS = Number(process.env.TOKEN_WAL_ROUNDS ?? 300)
const BLOCK = 50
const HOLD_MS = 50
const OFF_CPU_MS = 40
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const walBytes = () => { try { return fs.statSync(`${DB_PATH}-wal`).size } catch { return 0 } }

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
function newToken(): string {
  const id = uuid(), g = generateAccessToken()
  db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes)
    VALUES (?,?,?,?,?,'read')`).run(id, uid, `t-${id.slice(0, 6)}`, g.tokenHash, g.tokenPrefix)
  return id
}
const written = db.prepare('SELECT last_used_at IS NOT NULL FROM access_tokens WHERE id = ?').pluck()

const ways = ['growing', 'sized'] as const
const totals = Object.fromEntries(ways.map(w => [w, { rounds: 0, grew: 0, notEmptied: 0, ms: [] as number[],
  offCpu: [] as string[] }]))
const other = new Database(DB_PATH)
const t0 = performance.now()
for (let b = 0; b < Math.ceil(ROUNDS / BLOCK) * ways.length; b++) {
  const way = ways[b % ways.length]
  if (way === 'sized') {
    db.pragma('wal_checkpoint(TRUNCATE)')
    const r = sizeWalFile(db, DB_PATH)
    console.log(`block ${b} (sized): ${JSON.stringify(r)}`)
  }
  for (let i = 0; i < BLOCK; i++) {
    const t = totals[way]
    const id = newToken()
    if (way === 'growing') {
      db.pragma('wal_checkpoint(TRUNCATE)')
      if (walBytes() > 0) t.notEmptied++
    }
    other.exec('BEGIN IMMEDIATE')
    other.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(`p${b}-${i}`, uid)
    const from = probe.records().length
    noteTokenUse(id, Date.now())
    await sleep(HOLD_MS)
    other.exec('COMMIT')
    const end = Date.now() + 5000
    while (!written.get(id)) {
      if (Date.now() > end) throw new Error(`round ${b}/${i}: not written within 5 s`)
      await sleep(5)
    }
    const landed = probe.records().slice(from).pop()
    if (!landed) throw new Error(`round ${b}/${i}: no transaction recorded`)
    t.rounds++
    if (landed.grew) t.grew++
    t.ms.push(landed.ms)
    if (landed.ms - landed.cpuMs >= OFF_CPU_MS) {
      const line = `${way} block ${b} round ${i}: ${transactionLine(landed)}`
      t.offCpu.push(line)
      console.log(line)
    }
  }
}
other.close()
const sorted = (a: number[]) => [...a].sort((x, y) => x - y)
const at = (a: number[], q: number) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * q))]
console.log(`${ROUNDS} rounds a way, ${HOLD_MS} ms hold, ${((performance.now() - t0) / 60000).toFixed(1)} min`)
for (const way of ways) {
  const t = totals[way]
  console.log(`${way}: ${t.rounds} writes, ${t.grew} grew the -wal (${t.notEmptied} rounds the WAL wasn't emptied); `
    + `median ${at(t.ms, 0.5).toFixed(1)} ms, 99th ${at(t.ms, 0.99).toFixed(1)} ms, max `
    + `${Math.max(...t.ms).toFixed(1)} ms; ${t.offCpu.length} spent ${OFF_CPU_MS} ms or more off the CPU`)
}
await closeWalCheckpointer()
process.exit(0)

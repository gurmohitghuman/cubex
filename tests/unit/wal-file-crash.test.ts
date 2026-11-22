// A kill mid-write keeps every committed row with the -wal file made its full size (lib/wal-file.ts): a child
// (wal-file-crash-child.ts) commits numbered batches into its own database after sizing the file, writing each batch's
// number once it's committed, and is killed KILLS times (SIGKILL; on Windows the process ends at once): on every fifth
// within 80 ms of starting to size it, else after a random number of batches and a random few ms. After each kill the
// database is opened again: intact, every batch the child wrote out there in full, any batch there in full or not at
// all, none past the one after its last; when the kill came after the sizing, the -wal file was still its full size
// (SQLite's own checkpoints in the commits never cut it). Closing that connection deletes the WAL, so each child sizes
// it again. Prints how the kills landed.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import constMod from '../../server/src/lib/constants'
const { DB_WAL_SIZE_LIMIT } = constMod as typeof import('../../server/src/lib/constants')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const KILLS = 20
const ROWS = 100
const requireHere = createRequire(import.meta.url)
const dir = fs.mkdtempSync(path.join(path.dirname(process.env.DB_PATH), 'crash-'))
const file = path.join(dir, 'crash.db')
const code = `require(${JSON.stringify(requireHere.resolve('tsx/cjs/api'))}).register();
  require(${JSON.stringify(requireHere.resolve('./wal-file-crash-child.ts'))});`
const walBytes = () => { try { return fs.statSync(`${file}-wal`).size } catch { return 0 } }

interface Killed { printed: number[]; sized: string | null; walBytes: number }
function killOnce(k: number): Promise<Killed> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, DB_PATH: file, CRASH_ROWS: String(ROWS) } })
    const printed: number[] = []
    const after = 1 + Math.floor(Math.random() * 30)
    let sized: string | null = null
    let killing = false
    let buf = ''
    const kill = (ms: number) => {
      if (killing) return
      killing = true
      setTimeout(() => child.kill('SIGKILL'), ms)
    }
    child.stdout.on('data', chunk => {
      buf += chunk
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        // About as long as the sizing takes here (90 ms), so some land while it writes.
        if (line === 'sizing') { if (k % 5 === 0) kill(Math.random() * 80) }
        else if (line.startsWith('ready ')) sized = line.slice(6)
        // Other lines (lib/db.ts names the database it opened) aren't the child's batches.
        else if (/^\d+$/.test(line)) {
          printed.push(Number(line))
          if (printed.length >= after) kill(Math.random() * 5)
        }
      }
    })
    child.on('error', reject)
    child.on('close', () => resolve({ printed, sized, walBytes: walBytes() }))
  })
}

let failures = 0
let committedUnsaid = 0, batches = 0, last = 0
const sizingKills: number[] = []
for (let k = 0; k < KILLS; k++) {
  const killed = await killOnce(k)
  const db = new Database(file)
  try {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    const counts = new Map((db.prepare('SELECT batch, count(*) AS n FROM crash_rows GROUP BY batch').all() as
      Array<{ batch: number; n: number }>).map(r => [r.batch, r.n]))
    for (const [b, n] of counts) assert.equal(n, ROWS, `batch ${b} has ${n} rows: all or none`)
    for (const b of killed.printed) assert.ok(counts.has(b), `batch ${b} was committed and is missing`)
    const said = killed.printed.length ? killed.printed[killed.printed.length - 1] : last
    const most = Math.max(0, ...counts.keys())
    assert.ok(most <= said + 1, `batch ${most} is there, past the one after the last committed (${said})`)
    if (most === said + 1) committedUnsaid++
    if (killed.sized === null) sizingKills.push(killed.walBytes)
    else if (killed.printed.length) {
      // The child's journal_size_limit (lib/db.ts).
      assert.ok(killed.walBytes >= DB_WAL_SIZE_LIMIT, `the -wal file was ${killed.walBytes} bytes when killed`)
    }
    batches += killed.printed.length
    last = most
  } catch (e) {
    failures++
    console.log('FAIL', `kill ${k + 1}: ${(e as Error).message}`)
  } finally {
    db.close()
  }
}
const mb = (b: number) => (b / 1048576).toFixed(1)
console.log(`      ${KILLS} kills: ${sizingKills.length} before the sizing answered (the -wal file at `
  + `${sizingKills.map(mb).join(', ')} MB), ${committedUnsaid} just after a commit `
  + `the child hadn't written out yet, the rest while it committed; ${batches} batches written out, all there`)
if (failures === 0) console.log('ok   a kill mid-write and a reopen keep every committed row, the -wal file sized')
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
if (failures > 0) { console.error(`${failures} wal-file-crash assertion(s) failed`); process.exit(1) }
console.log('All wal-file-crash assertions passed.')

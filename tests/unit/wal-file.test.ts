// The WAL file made its full size at start (lib/wal-file.ts), switched on here as on Windows: zeros from the file's
// end to journal_size_limit, synced, the data intact and SQLite not cutting it back when the WAL starts over; a
// nearly full disk skips it and writes nothing; a write failing part way leaves the file at the size it had. Then the
// hiring summary's first pass on a sized file: no transaction on the API connection grows it (grown from empty,
// several do; on the Windows runner such commits waited on the OS, once 233 ms). Prints the sizing's time.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { sqliteWriteProbe } from './sqlite-write-probe'
const { db, uid, ok, done, sheet } = undoKit('wal-file')
const W = await import('../../server/src/lib/wal-file')
const { WAL_FILE_FREE_MARGIN } = await import('../../server/src/lib/constants')
const { summarizeHiring } = await import('../../server/src/services/hiring-summarize')
const { COMPANY_COLUMNS: C, ROLE_COLUMNS: R } = await import('../../server/src/lib/hiring/names')
const { checkpointAsked, walCheckpointerIdle } = await import('../../server/src/lib/wal-checkpointer')

const dbPath = process.env.DB_PATH!
const walPath = `${dbPath}-wal`
const limit = Number(db.pragma('journal_size_limit', { simple: true }))
const walSize = () => fs.statSync(walPath).size
db.exec('CREATE TABLE IF NOT EXISTS wal_file_rows (n INTEGER PRIMARY KEY, pad TEXT)')
const add = db.prepare('INSERT INTO wal_file_rows (pad) VALUES (?)')
const rowsHere = () => db.prepare('SELECT count(*) FROM wal_file_rows').pluck().get() as number
// As a server's WAL is after a start: emptied, then begun again by one small write.
function begun(): number {
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.pragma(`user_version = ${Number(db.pragma('user_version', { simple: true }))}`)
  return walSize()
}
const zerosFrom = (from: number) => {
  const fd = fs.openSync(walPath, 'r')
  const buf = Buffer.alloc(1024 * 1024)
  try {
    for (let at = from; at < limit; at += buf.length) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, limit - at), at)
      if (buf.subarray(0, n).some(b => b !== 0)) return false
    }
    return true
  } finally { fs.closeSync(fd) }
}
const errors: string[] = []
const logged = <T>(fn: () => T): T => {
  const real = console.error
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')) }
  try { return fn() } finally { console.error = real }
}

await ok('sized: zeros from the end to journal_size_limit, synced; the data intact, not cut back at a start-over',
  async () => {
    W.setWalFileSizingForTests(false)
    assert.deepEqual(W.sizeWalFile(db, dbPath), { done: 'skipped', why: 'off' })
    W.setWalFileSizingForTests(true)
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const from = begun()
      const r = W.sizeWalFile(db, dbPath)
      assert.ok(r.done === 'sized' && r.from === from && r.to === limit, JSON.stringify(r))
      times.push(r.ms)
      assert.equal(walSize(), limit)
      assert.ok(zerosFrom(from), 'zeros past the end the file had')
    }
    console.log(`      sized to ${limit / 1048576} MB in ${times.map(t => t.toFixed(0)).join(', ')} ms`)
    assert.deepEqual(W.sizeWalFile(db, dbPath), { done: 'skipped', why: 'big enough' })
    const before = rowsHere()
    for (let i = 0; i < 50; i++) {
      db.transaction(() => { for (let j = 0; j < 40; j++) add.run('x'.repeat(500)) }).immediate()
    }
    // Every frame copied back, then a write: SQLite starts the WAL over and cuts the file only past the limit.
    db.pragma('wal_checkpoint(PASSIVE)')
    db.transaction(() => { add.run('after') }).immediate()
    assert.equal(walSize(), limit, 'the file kept its size when the WAL started over')
    assert.equal(rowsHere(), before + 50 * 40 + 1)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  })

await ok('a nearly full disk: skipped and logged, nothing written', async () => {
  const from = begun()
  const needed = limit - from
  const tight = { freeBytes: () => needed + WAL_FILE_FREE_MARGIN - 1, write: () => { throw new Error('no write') } }
  errors.length = 0
  const r = logged(() => W.sizeWalFile(db, dbPath, tight))
  assert.deepEqual(r, { done: 'skipped', why: 'low disk', free: needed + WAL_FILE_FREE_MARGIN - 1, needed })
  const unknown = logged(() => W.sizeWalFile(db, dbPath, { ...tight, freeBytes: () => null }))
  assert.equal(unknown.done === 'skipped' && unknown.why, 'low disk')
  assert.equal(walSize(), from)
  assert.equal(errors.length, 2, errors.join(' | '))
  assert.match(errors[0], /^The WAL file wasn't made 64 MB at start: the disk has \d+ MB free, under \d+ MB\./)
})

await ok('a write failing part way: the file cut back to the size it had, logged, the database still written',
  async () => {
    const from = begun()
    let writes = 0
    const write = (fd: number, z: Buffer, n: number, at: number) => {
      if (++writes > 3) throw new Error('ENOSPC: no space left on device')
      return fs.writeSync(fd, z, 0, n, at)
    }
    const failing = { freeBytes: () => Number.MAX_SAFE_INTEGER, write }
    errors.length = 0
    const r = logged(() => W.sizeWalFile(db, dbPath, failing))
    assert.deepEqual(r, { done: 'failed', error: 'ENOSPC: no space left on device', from })
    assert.equal(walSize(), from)
    assert.match(errors.join(' | '), /^The WAL file couldn't be made 64 MB at start \(ENOSPC/)
    const before = rowsHere()
    db.transaction(() => { add.run('still written') }).immediate()
    assert.equal(rowsHere(), before + 1)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  })

await ok('the summary\'s first pass on a sized -wal file: no transaction grows it (grown from empty, several do)',
  async () => {
    const N = 20_000
    const roles = sheet([], Object.values(R))
    const companies = sheet([], Object.values(C))
    const runId = uuid()
    const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        insert.run(uuid(), roles, uid, i, JSON.stringify({ [R.title]: 'SDR', [R.company]: `Company ${i % (N / 4)}`,
          [R.domain]: `c${i % (N / 4)}.com`, [R.posted]: '2026-11-10', [R.link]: `https://jobs.example/${i}`,
          [R.location]: 'Austin, TX' }))
      }
    }).immediate()
    const probe = sqliteWriteProbe(db, dbPath, checkpointAsked)
    const pass = async (sized: boolean) => {
      db.transaction(() => { db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(companies) }).immediate()
      W.setWalFileSizingForTests(sized)
      await walCheckpointerIdle()
      probe.reset()
      const s = await summarizeHiring(uid, { roles, companies }, { label: '2026-11-11', sinceLabel: null, runId })
      assert.ok(!('gone' in s) && s.companiesNew === N / 4, JSON.stringify(s))
      const records = probe.records()
      return { commits: records.length, grew: records.filter(r => r.grew).length }
    }
    const grown = await pass(false)
    const sized = await pass(true)
    console.log(`      grown from empty: ${grown.grew} of ${grown.commits} transactions grew the -wal file; `
      + `sized first: ${sized.grew} of ${sized.commits}`)
    assert.ok(grown.grew >= 3, `${grown.grew} grew it from empty: the check sees growth`)
    assert.ok(sized.commits >= 10, `${sized.commits} transactions`)
    assert.equal(sized.grew, 0, 'transactions that grew the sized -wal file')
    await walCheckpointerIdle()
    assert.equal(walSize(), limit, 'still its full size after the pass and its start-over')
  })

W.setWalFileSizingForTests(null)
done()

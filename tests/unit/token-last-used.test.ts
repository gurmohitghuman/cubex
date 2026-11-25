// An access token's last use written after the request, never waiting on the server's thread
// (server/src/lib/token-last-used.ts), through the real token auth on a migrated throwaway database:
//   - a call goes on before the write, which follows within a moment, at the time of the use;
//   - a second call within ACCESS_TOKEN_LAST_USED_WRITE_INTERVAL_MS writes nothing again (the throttle, as before);
//   - another connection holding the write lock 2 s (as a run's worker committing on a slow disk): calls aren't
//     held and the event loop never is; the use waits, and is written once the lock is let go, within
//     ACCESS_TOKEN_LAST_USED_RETRY_MS, still at the time of the use;
//   - a write never moves last_used_at back, and one for a token deleted meanwhile changes nothing;
//   - at shutdown, a use still waiting is written at once.
// Where a server makes the -wal file its full size at start (Windows), so does this, after the migrations: no write
// in the lock case grows it (on the Windows runner the write that did once waited on the OS, holding the loop 103 ms
// with no CPU time). A hold of 50 ms or more prints the transactions in it.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { v4 as uuid } from 'uuid'
import type BetterSqlite from 'better-sqlite3'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const Database = createRequire(path.resolve('server/src/queue.ts'))('better-sqlite3') as typeof BetterSqlite
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { generateAccessToken } = await import('../../server/src/lib/access-token')
const { authenticateAccessToken } = await import('../../server/src/middleware/access-token-auth')
const { noteTokenUse, tokenUsesWaiting, writeTokenUsesNow } = await import('../../server/src/lib/token-last-used')
const { ACCESS_TOKEN_LAST_USED_RETRY_MS } = await import('../../server/src/lib/constants')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
const { takeWalTurnStats } = await import('../../server/src/lib/wal-turn')
const { heldText, loopWatch } = await import('./loop-watch')
const { sizeWalLikeAServer, sqliteWriteProbe, transactionLine, walGrowth } = await import('./sqlite-write-probe')
runMigrations()
const walSized = sizeWalLikeAServer(db, process.env.DB_PATH!)
console.error = () => {}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let failures = 0
const ok = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
// A token in the database, and a call with it through token auth: how long the call took to go on.
function newToken() {
  const id = uuid(), g = generateAccessToken()
  db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes)
    VALUES (?,?,?,?,?,'read')`).run(id, uid, `t-${id.slice(0, 6)}`, g.tokenHash, g.tokenPrefix)
  return { id, token: g.token }
}
function call(token: string): number {
  let went = false
  const res = { status: () => res, set: () => res, json: () => res }
  const t0 = performance.now()
  authenticateAccessToken({ headers: { authorization: `Bearer ${token}` } } as never, res as never,
    () => { went = true })
  assert.ok(went, 'token auth let the call go on')
  return performance.now() - t0
}
const lastUsed = (id: string) => db.prepare('SELECT last_used_at FROM access_tokens WHERE id = ?').pluck()
  .get(id) as string | null
const asStored = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ')
async function until(what: string, test: () => boolean, ms: number): Promise<number> {
  const t0 = Date.now()
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
  return Date.now() - t0
}

await ok('a call goes on before the write, which follows at the time of the use; the throttle holds', async () => {
  const t = newToken()
  const usedAt = Date.now()
  call(t.token)
  assert.equal(lastUsed(t.id), null, 'not written inside token auth')
  await until('the write', () => lastUsed(t.id) !== null, 1000)
  assert.equal(lastUsed(t.id), asStored(usedAt))
  db.prepare("UPDATE access_tokens SET last_used_at = '2000-01-01 00:00:00' WHERE id = ?").run(t.id)
  call(t.token)
  await sleep(100)
  assert.equal(lastUsed(t.id), '2000-01-01 00:00:00', 'a second call within the interval wrote again')
  assert.equal(tokenUsesWaiting(), 0)
})

await ok('another connection holding the write lock: no call or loop held; written once it lets go', async () => {
  const t = newToken()
  const other = new Database(process.env.DB_PATH!)
  other.exec('BEGIN IMMEDIATE')
  other.prepare("UPDATE users SET password_hash = 'y' WHERE id = ?").run(uid)
  const probe = sqliteWriteProbe(db, process.env.DB_PATH!)
  const grown = walGrowth(process.env.DB_PATH!, walSized)
  const watch = loopWatch(probe.records)
  await watch.ready
  const usedAt = Date.now()
  const took = call(t.token)
  await sleep(2000)
  assert.equal(lastUsed(t.id), null)
  assert.equal(tokenUsesWaiting(), 1)
  other.exec('COMMIT')
  const after = await until('the write once the lock is free', () => lastUsed(t.id) !== null, 3000)
  const watched = watch()
  other.close()
  console.log(`      the call went on in ${took.toFixed(1)} ms; ${heldText(watched)}; written `
    + `${after} ms after the lock was let go`)
  if (watched.ownMs >= 50) console.log(`      in it: ${watched.inside.map(transactionLine).join(' | ') || 'none'}`)
  assert.equal(grown(probe.records()), '', 'writes that grew the -wal file')
  assert.ok(took < 50, `the call took ${took.toFixed(0)} ms`)
  assert.ok(watched.ownMs < 100, `the event loop was held ${watched.ownMs.toFixed(0)} ms by this thread`)
  assert.ok(after <= ACCESS_TOKEN_LAST_USED_RETRY_MS + 500, `written ${after} ms after the lock was let go`)
  assert.equal(lastUsed(t.id), asStored(usedAt), 'the time of the use, not of the write')
  assert.equal(tokenUsesWaiting(), 0)
})

await ok('a write never moves last_used_at back; one for a deleted token changes nothing', async () => {
  const t = newToken()
  db.prepare("UPDATE access_tokens SET last_used_at = '2999-01-01 00:00:00' WHERE id = ?").run(t.id)
  noteTokenUse(t.id, Date.now())
  noteTokenUse(uuid(), Date.now())
  await until('both written', () => tokenUsesWaiting() === 0, 1000)
  assert.equal(lastUsed(t.id), '2999-01-01 00:00:00')
})

await ok('at shutdown, a use still waiting is written at once', async () => {
  const t = newToken()
  const other = new Database(process.env.DB_PATH!)
  other.exec('BEGIN IMMEDIATE')
  other.prepare("UPDATE users SET password_hash = 'z' WHERE id = ?").run(uid)
  const usedAt = Date.now()
  noteTokenUse(t.id, usedAt)
  await sleep(100)
  assert.equal(tokenUsesWaiting(), 1)
  other.exec('COMMIT')
  other.close()
  writeTokenUsesNow()
  assert.equal(lastUsed(t.id), asStored(usedAt))
  assert.equal(tokenUsesWaiting(), 0)
})

await ok('after a write refused and then made, busy_timeout is back as it was for the thread\'s other writes',
  async () => {
  const before = db.pragma('busy_timeout', { simple: true })
  const t = newToken()
  const other = new Database(process.env.DB_PATH!)
  other.exec('BEGIN IMMEDIATE')
  other.prepare("UPDATE users SET password_hash = 'w' WHERE id = ?").run(uid)
  noteTokenUse(t.id, Date.now())
  await sleep(150)
  assert.equal(tokenUsesWaiting(), 1, 'refused while the lock was held')
  assert.equal(db.pragma('busy_timeout', { simple: true }), before, 'busy_timeout while it waits')
  other.exec('COMMIT')
  other.close()
  await until('the write', () => tokenUsesWaiting() === 0, ACCESS_TOKEN_LAST_USED_RETRY_MS + 1000)
  assert.equal(db.pragma('busy_timeout', { simple: true }), before, 'busy_timeout after the write')
  assert.ok(before === 5000, `busy_timeout is ${before}`)
})

await ok('a use is written in turn with the checkpoint worker: one write, after another connection\'s checkpoint',
  async () => {
  const t = newToken()
  const other = new Database(process.env.DB_PATH!)
  other.pragma('wal_checkpoint(PASSIVE)')
  other.close()
  takeWalTurnStats()
  noteTokenUse(t.id, Date.now())
  await until('the write', () => tokenUsesWaiting() === 0, 2000)
  const stats = takeWalTurnStats()
  console.log(`      wal turn: ${JSON.stringify(stats)}`)
  assert.equal(stats.writes, 1, 'the write went through the WAL turn')
  assert.equal(stats.asks, 1, 'it asked the worker for the checkpoint its write left due')
})

await closeWalCheckpointer()
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
process.exit(0)

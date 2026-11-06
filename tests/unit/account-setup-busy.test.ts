// Choosing the first password must wait for another writer instead of failing.
// At startup, worker threads write the database through their own connections.
// createAccount reads (does an account exist?) and then writes; as a deferred
// transaction, its write found the lock taken and failed at once with
// SQLITE_BUSY (the busy timeout doesn't apply to a read upgrading to a write),
// and setup answered 500. Here a child process holds the write lock for 1000 ms
// while createAccount runs: it must wait, then create the account.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import accountMod from '../../server/src/services/account'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { createAccount } = accountMod as typeof import('../../server/src/services/account')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const HOLD_MS = 1000
const requireHere = createRequire(import.meta.url)

// Another connection, like a worker thread's: takes the write lock, writes,
// says so, holds the lock HOLD_MS, then commits. The time it prints is taken
// just before COMMIT, so a call that waited for the lock always returns after it.
const holder = `const Database = require(process.env.HOLD_SQLITE);
  const db = new Database(process.env.DB_PATH);
  db.pragma('busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT INTO lookup_dirty (sheet_id, rid, user_id) VALUES ('held-sheet', 1, 'held-user')").run();
  console.log('locked');
  setTimeout(() => {
    const at = Date.now(); db.exec('COMMIT'); db.close(); console.log('committed ' + at);
  }, ${HOLD_MS});`

async function main(): Promise<void> {
  const child = spawn(process.execPath, ['-e', holder], {
    env: { ...process.env, HOLD_SQLITE: requireHere.resolve('better-sqlite3') },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let out = ''
  const locked = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('locked\n')) resolve() })
    child.on('error', reject)
    child.on('close', (code) => reject(new Error(`the lock holder exited (${code}) before locking: ${out}`)))
  })
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
  await locked
  console.log('ok   another connection holds the write lock')

  const calledAt = Date.now()
  let id: string | null = null
  let error: unknown = null
  try { id = createAccount('not-a-real-hash') } catch (err) { error = err }
  const returnedAt = Date.now()
  const code = await closed
  assert.equal(code, 0, `the lock holder failed: ${out}`)
  const committedAt = Number(/committed (\d+)/.exec(out)?.[1])
  // Without this, a slow start could let the lock go before createAccount ran
  // and the test would pass without testing anything.
  assert.ok(calledAt < committedAt, 'createAccount ran while the other connection still held the lock')
  // The fix under test: createAccount returned only after the other connection
  // committed, so it waited for the lock instead of giving up.
  const failure = error ? ` (${(error as { code?: string }).code})` : ''
  assert.ok(returnedAt >= committedAt,
    `createAccount returned ${committedAt - returnedAt} ms before the other connection committed${failure}`)

  if (error) {
    const e = error as { code?: string; message?: string }
    assert.fail(`createAccount failed instead of waiting for the lock: ${e.code} ${e.message}`)
  }
  assert.equal(typeof id, 'string')
  console.log(`ok   createAccount waited ${returnedAt - calledAt} ms for the lock, then created the account`)

  const users = db.prepare('SELECT id FROM users').all() as { id: string }[]
  assert.deepEqual(users, [{ id }])
  const settings = db.prepare('SELECT COUNT(*) AS c FROM settings WHERE user_id = ?').get(id) as { c: number }
  assert.equal(settings.c, 1)
  const held = db.prepare("SELECT COUNT(*) AS c FROM lookup_dirty WHERE sheet_id = 'held-sheet'").get() as { c: number }
  assert.equal(held.c, 1)
  console.log('ok   one account, its settings row, and the other connection\'s write all stand')
}

main().then(
  () => console.log('\nAll account-setup-busy assertions passed.'),
  (err) => { console.error(err); process.exit(1) },
)

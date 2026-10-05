// INITIAL_PASSWORD creates the single account at boot, so an install that is
// public from the start (Coolify) is never open to first-run setup. Pins: unset
// does nothing; an unusable value throws and creates nothing (the boot stops
// instead of leaving setup open); a valid value creates the account and its
// settings row with a hash that verifies; once the account exists, any value
// (even an unusable one) is ignored and the stored password is untouched; and
// setup's createAccount can't add a second account.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import accountMod from '../../server/src/services/account'
import passwordMod from '../../server/src/lib/password'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { accountExists, createAccount, createAccountFromEnv } =
  accountMod as typeof import('../../server/src/services/account')
const { verifyPassword } = passwordMod as typeof import('../../server/src/lib/password')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const users = () => db.prepare('SELECT id, password_hash FROM users').all() as { id: string; password_hash: string }[]

async function main(): Promise<void> {
  assert.equal(await createAccountFromEnv(undefined), 'unset')
  assert.equal(await createAccountFromEnv(''), 'unset')
  assert.equal(accountExists(), false)
  console.log('ok   unset or empty: no account')

  await assert.rejects(createAccountFromEnv('short'), /INITIAL_PASSWORD can't be used/)
  assert.equal(accountExists(), false)
  console.log('ok   unusable value: throws, creates nothing')

  assert.equal(await createAccountFromEnv('first-boot-pass'), 'created')
  const [user] = users()
  assert.equal(users().length, 1)
  assert.ok(await verifyPassword('first-boot-pass', user.password_hash))
  const settings = db.prepare('SELECT COUNT(*) AS c FROM settings WHERE user_id = ?').get(user.id) as { c: number }
  assert.equal(settings.c, 1)
  console.log('ok   valid value: account + settings row, password verifies')

  assert.equal(await createAccountFromEnv('a-different-pass'), 'exists')
  assert.equal(await createAccountFromEnv('short'), 'exists')
  assert.deepEqual(users(), [user])
  console.log('ok   account exists: value ignored, password untouched')

  assert.equal(createAccount(user.password_hash), null)
  assert.equal(users().length, 1)
  console.log('ok   setup path refuses a second account')
}

main().then(
  () => console.log('\nAll initial-password assertions passed.'),
  (err) => { console.error(err); process.exit(1) },
)

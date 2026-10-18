// "Run finished" webhooks, sending, against a migrated throwaway DB
// (services/run-hooks.ts, run-hooks-dispatch.ts, lib/run-hook-sign.ts): every
// try goes through the SSRF guard (a private URL is refused at send time too,
// not only when saved); a test is sent once and logged; the log keeps 50; a
// restart sends cut-off deliveries again; signing and the receiver's check.
// Every URL here is private, so nothing leaves the machine. The queue:
// run-hooks-queue.test.ts.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import cryptoMod from '../../server/src/lib/crypto'
import signMod from '../../server/src/lib/run-hook-sign'
import redactMod from '../../server/src/lib/redact'
import dispatchMod from '../../server/src/services/run-hooks-dispatch'
import hooksMod from '../../server/src/services/run-hooks'
import constMod from '../../server/src/lib/constants-run-hooks'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')
const { signRunHookBody, verifyRunHookSignature, newRunHookSecret, noticeBody } =
  signMod as typeof import('../../server/src/lib/run-hook-sign')
const { redactSecrets } = redactMod as typeof import('../../server/src/lib/redact')
const { fanOutRunEvents, claimDelivery, deliver, startRunHookLoop, runHookSweep } =
  dispatchMod as typeof import('../../server/src/services/run-hooks-dispatch')
const { createRunWebhook, testRunWebhook, listRunWebhooks, deleteRunWebhook } =
  hooksMod as typeof import('../../server/src/services/run-hooks')
const { RUN_HOOK_LOG_KEEP } =
  constMod as typeof import('../../server/src/lib/constants-run-hooks')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), other = uuid(), tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(other, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, uid, 'S', '[]')

const aiRun = (status = 'running') => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status) VALUES (?,?,?,?,?,?)`)
    .run(id, sheetId, uid, 'C', 'p', status)
  return id
}
const set = (table: string, id: string, status: string) =>
  db.prepare(`UPDATE ${table} SET status = ? WHERE id = ?`).run(status, id)
const hook = (url: string, everyRun: boolean, user = uid, secret = 'cubex_whsig_test_secret_value_000000') => {
  const id = uuid()
  db.prepare('INSERT INTO run_webhooks (id, user_id, url, secret_encrypted, every_run) VALUES (?,?,?,?,?)')
    .run(id, user, url, encrypt(secret), everyRun ? 1 : 0)
  return id
}


const every = hook('http://127.0.0.1:9/every', true)
const named = hook('http://127.0.0.1:9/named', false)
const someoneElse = hook('http://127.0.0.1:9/other', true, other)

async function main() {
  // --- Every try goes through the SSRF guard ---
  const r = aiRun()
  set('ai_runs', r, 'completed')
  fanOutRunEvents()
  const id = db.prepare('SELECT id FROM run_webhook_deliveries WHERE run_id = ?').pluck().get(r) as string
  check('a delivery is claimed once', claimDelivery(id) && !claimDelivery(id))
  await deliver(id)
  const d = db.prepare('SELECT * FROM run_webhook_deliveries WHERE id = ?').get(id) as Record<string, any>
  check('a private URL is refused when sending, not retried', d.state === 'failed' && d.tries === 1
    && /^Not sent: .*private\/internal address/.test(d.error) && d.response_code === null && !!d.finished_at, d)

  // --- A test notice, once, logged ---
  const t = await testRunWebhook(uid, every)
  check('a test is tried once and logged',
    'ok' in t && t.ok.event === 'test' && t.ok.tries === 1 && t.ok.state === 'failed', t)
  check('a test of another account\'s webhook is not found', 'fail' in await testRunWebhook(uid, someoneElse))

  // --- The log keeps the newest 50 ---
  const ins = db.prepare(`INSERT INTO run_webhook_deliveries (id, user_id, webhook_id, event, body, state, next_try_at,
    created_at) VALUES (?, ?, ?, 'run.finished', '{}', 'delivered', 0, ?)`)
  db.transaction(() => {
    for (let i = 0; i < 60; i++) ins.run(uuid(), uid, every, `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`)
  })()
  await testRunWebhook(uid, every)
  const kept = db.prepare(`SELECT COUNT(*) FROM run_webhook_deliveries WHERE webhook_id = ?
    AND state IN ('delivered', 'failed')`).pluck().get(every)
  check(`the log keeps the newest ${RUN_HOOK_LOG_KEEP}`, kept === RUN_HOOK_LOG_KEEP, kept)

  // --- Saving a URL: the guard and plain checks ---
  const refused = async (url: string, re: RegExp) => {
    const out = await createRunWebhook(uid, { url })
    return 'fail' in out && re.test(out.message)
  }
  check('a loopback URL is refused', await refused('http://127.0.0.1:3000/x', /only to public addresses/))
  check('localhost is refused', await refused('http://localhost/x', /only to public addresses/))
  check('metadata is refused', await refused('http://169.254.169.254/latest', /only to public addresses/))
  check('ftp is refused', await refused('ftp://example.com/x', /http:\/\/ or https:\/\//))
  check('user:password is refused', await refused('https://u:p@example.com/x', /user name or password/))
  check('not a URL is refused', await refused('example', /full http/))
  check('every_run must be a boolean',
    'fail' in await createRunWebhook(uid, { url: 'https://x.co', every_run: 'yes' }))
  check('the list never shows a secret', !JSON.stringify(listRunWebhooks(uid)).includes('secret'))

  // --- One notice at a time per URL; an idle sweep queues nothing ---
  check('nothing queued: fan-out is a no-op', fanOutRunEvents() === 0)
  db.prepare('DELETE FROM run_webhook_deliveries').run()
  const pend = db.prepare(`INSERT INTO run_webhook_deliveries (id, user_id, webhook_id, event, body, state,
    next_try_at) VALUES (?, ?, ?, 'run.finished', '{}', 'pending', ?)`)
  for (let i = 0; i < 3; i++) pend.run(uuid(), uid, every, Date.now() - 1000 + i)
  pend.run(uuid(), uid, named, Date.now())
  runHookSweep()
  const sending = (hook: string) => db.prepare(`SELECT COUNT(*) FROM run_webhook_deliveries
    WHERE webhook_id = ? AND state = 'sending'`).pluck().get(hook)
  check('a URL with three due notices gets one out at a time', sending(every) === 1, sending(every))
  check('... while another URL still gets its turn', sending(named) === 1, sending(named))
  await new Promise(r => setTimeout(r, 300))
  runHookSweep()
  check('the next one goes once the first is done', sending(every) === 1)
  await new Promise(r => setTimeout(r, 300))

  // --- A restart sends cut-off deliveries again; a cut-off test is logged ---
  const cut = uuid(), cutTest = uuid()
  const sendingRow = db.prepare(`INSERT INTO run_webhook_deliveries (id, user_id, webhook_id, event, body, state,
    tries, next_try_at) VALUES (?, ?, ?, ?, '{}', 'sending', 1, 0)`)
  sendingRow.run(cut, uid, every, 'run.finished')
  sendingRow.run(cutTest, uid, every, 'test')
  startRunHookLoop()
  const after = db.prepare('SELECT state FROM run_webhook_deliveries WHERE id = ?').pluck().get(cut)
  check('a delivery left sending is pending again after a restart', after === 'pending', after)
  const t2 = db.prepare('SELECT state, error FROM run_webhook_deliveries WHERE id = ?').get(cutTest) as
    { state: string; error: string }
  check('a test cut off by a restart is logged, not sent again',
    t2.state === 'failed' && /restarted/.test(t2.error), t2)

  // --- Deleting a webhook takes its log ---
  check('delete', deleteRunWebhook(uid, named) && !deleteRunWebhook(uid, named))
  check('its deliveries go with it', db.prepare('SELECT COUNT(*) FROM run_webhook_deliveries WHERE webhook_id = ?')
    .pluck().get(named) === 0)

  // --- Signing ---
  const secret = newRunHookSecret()
  check('a secret: the prefix and 32 random bytes', /^cubex_whsig_[A-Za-z0-9_-]{43}$/.test(secret), secret)
  check('secrets differ', newRunHookSecret() !== secret)
  const body = noticeBody({ event: 'run.finished', run_id: 'r', kind: 'http', sheet_id: 's', status: 'completed',
    finished_at: '2026-10-17T00:00:00.000Z' })
  const sig = signRunHookBody(secret, body)
  check('sha256=<64 hex>', /^sha256=[0-9a-f]{64}$/.test(sig))
  check('the receiver\'s check passes', verifyRunHookSignature(secret, body, sig))
  check('a changed body fails', !verifyRunHookSignature(secret, body.replace('completed', 'failed'), sig))
  check('another secret fails', !verifyRunHookSignature(newRunHookSecret(), body, sig))
  check('no header fails',
    !verifyRunHookSignature(secret, body, undefined) && !verifyRunHookSignature(secret, body, ''))
  check('a known HMAC vector', signRunHookBody('key', 'The quick brown fox jumps over the lazy dog')
    === 'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
  check('a secret never reaches a log', !redactSecrets(`oops ${secret} here`).includes(secret))

  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
  console.log('\nrun hooks send: all passed')
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })

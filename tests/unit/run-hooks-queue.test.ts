// "Run finished" webhooks, the queue, against a migrated throwaway DB
// (migration 034, services/run-hooks-attach.ts, run-hooks-dispatch.ts): the
// triggers queue one notice per final status, for each run kind, only when
// someone should hear it; a run named after it finished is still told, once;
// fan-out makes one delivery per webhook with the exact body; a full queue logs
// instead of growing. Sending: run-hooks-send.test.ts.
// Over 200 lines: one walk through the queue's states, each step building on the last.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import cryptoMod from '../../server/src/lib/crypto'
import attachMod from '../../server/src/services/run-hooks-attach'
import dispatchMod from '../../server/src/services/run-hooks-dispatch'
import constMod from '../../server/src/lib/constants-run-hooks'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')
const { attachRunWebhook, webhookIdProblem } =
  attachMod as typeof import('../../server/src/services/run-hooks-attach')
const { fanOutRunEvents } =
  dispatchMod as typeof import('../../server/src/services/run-hooks-dispatch')
const { RUN_HOOK_MAX_WAITING } =
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

const events = () => db.prepare('SELECT * FROM run_webhook_events ORDER BY id').all() as Array<Record<string, any>>
const clearEvents = () => db.prepare('DELETE FROM run_webhook_events').run()
const aiRun = (status = 'running') => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, status) VALUES (?,?,?,?,?,?)`)
    .run(id, sheetId, uid, 'C', 'p', status)
  return id
}
const httpRun = (config: string, status = 'running') => {
  const id = uuid()
  db.prepare('INSERT INTO http_runs (id, sheet_id, user_id, config, status) VALUES (?,?,?,?,?)')
    .run(id, sheetId, uid, config, status)
  return id
}
const setupRun = () => {
  const id = uuid()
  db.prepare(`INSERT INTO setup_runs (id, user_id, sheet_id, setup_name, plan, steps) VALUES (?,?,?,?,?,?)`)
    .run(id, uid, sheetId, 'S', '{"spec":{"steps":[]},"layers":[]}', '[]')
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

// --- No webhook: nothing is queued ---
{
  const r = aiRun()
  set('ai_runs', r, 'completed')
  check('without webhooks a finish queues nothing', events().length === 0)
}

// --- A webhook for every run: one notice per final status, each kind ---
const every = hook('http://127.0.0.1:9/every', true)
{
  const a = aiRun('pending')
  set('ai_runs', a, 'running')
  check('running is not final', events().length === 0)
  set('ai_runs', a, 'completed')
  const e = events()
  check('an AI run that completes queues one notice', e.length === 1 && e[0].kind === 'ai'
    && e[0].status === 'completed' && e[0].run_id === a && e[0].sheet_id === sheetId && e[0].webhook_id === null
    && /Z$/.test(e[0].finished_at), e)
  set('ai_runs', a, 'cancelled')
  check('final to final is not a second finish', events().length === 1)
  clearEvents()
  const h = httpRun('{"requestConfig":{"url":"x"},"responseMapping":[]}')
  set('http_runs', h, 'failed')
  const n = httpRun('{"enrichment":{"v":1},"requestConfig":{}}')
  set('http_runs', n, 'cancelled')
  const bad = httpRun('not json at all')
  const changed = db.prepare(`UPDATE http_runs SET status = 'failed' WHERE id = ?`).run(bad).changes
  const s = setupRun()
  set('setup_runs', s, 'done')
  const kinds = events().map(x => `${x.kind}:${x.status}`)
  check('HTTP, enrichment, broken-config HTTP and setup kinds; done reads completed',
    JSON.stringify(kinds)
      === JSON.stringify(['http:failed', 'enrichment:cancelled', 'http:failed', 'setup:completed']), kinds)
  check('a run whose config isn\'t JSON can still fail', changed === 1)
  clearEvents()
  set('http_runs', h, 'running')
  set('http_runs', h, 'completed')
  check('a run resumed and finished again is told again',
    events().length === 1 && events()[0].status === 'completed')
  clearEvents()
  set('ai_runs', aiRun(), 'paused')
  check('paused is not final', events().length === 0)
}

// --- Fan-out: one delivery per webhook that should hear it, the exact body ---
const named = hook('http://127.0.0.1:9/named', false)
const someoneElse = hook('http://127.0.0.1:9/other', true, other)
{
  const plain = aiRun()
  const mine = aiRun()
  db.prepare('UPDATE ai_runs SET webhook_id = ? WHERE id = ?').run(named, mine)
  set('ai_runs', plain, 'completed')
  set('ai_runs', mine, 'failed')
  const n = fanOutRunEvents()
  check('two notices fanned out, the queue emptied', n === 2 && events().length === 0)
  const rows = db.prepare('SELECT * FROM run_webhook_deliveries ORDER BY rowid').all() as Array<Record<string, any>>
  const to = (run: string) => rows.filter(r => r.run_id === run).map(r => r.webhook_id).sort()
  check('a plain run goes to the every-run webhook only', JSON.stringify(to(plain)) === JSON.stringify([every]))
  check('a run that names a webhook goes to it as well',
    JSON.stringify(to(mine)) === JSON.stringify([every, named].sort()))
  check('another account\'s webhook hears nothing', !rows.some(r => r.webhook_id === someoneElse))
  const d = rows.find(r => r.run_id === mine && r.webhook_id === named)!
  const body = JSON.parse(d.body)
  check('the body is the contract, in order',
    Object.keys(body).join(',') === 'event,run_id,kind,sheet_id,status,finished_at'
    && body.event === 'run.finished' && body.run_id === mine && body.kind === 'ai' && body.status === 'failed'
    && body.sheet_id === sheetId, body)
  check('deliveries start pending, due now, untried',
    d.state === 'pending' && d.tries === 0 && d.next_try_at <= Date.now())
  db.prepare('DELETE FROM run_webhook_deliveries').run()
}

// --- Naming a webhook after the run already finished ---
{
  db.prepare('UPDATE run_webhooks SET every_run = 0 WHERE id = ?').run(every)
  const quick = aiRun()
  set('ai_runs', quick, 'completed')
  check('nobody to tell: nothing queued', events().length === 0)
  attachRunWebhook('ai_runs', quick, uid, named)
  const e = events()
  check('attached after the finish: queued for that webhook only', e.length === 1 && e[0].named_only === 1
    && e[0].webhook_id === named && e[0].kind === 'ai', e)
  fanOutRunEvents()
  const to = db.prepare('SELECT webhook_id FROM run_webhook_deliveries WHERE run_id = ?').pluck().all(quick)
  check('... and only it gets a delivery', JSON.stringify(to) === JSON.stringify([named]))
  const before = aiRun()
  attachRunWebhook('ai_runs', before, uid, named)
  check('attached before the finish: nothing yet', events().length === 0)
  set('ai_runs', before, 'cancelled')
  check('... the trigger tells it',
    events().length === 1 && events()[0].webhook_id === named && events()[0].named_only === 0)
  clearEvents()
  db.prepare('UPDATE run_webhooks SET every_run = 1 WHERE id = ?').run(every)
  const done = aiRun()
  set('ai_runs', done, 'completed')
  attachRunWebhook('ai_runs', done, uid, every)
  check('an every-run webhook named after the finish isn\'t told twice', events().length === 1)
  clearEvents()
  const hr = httpRun('{"enrichment":{"v":1}}', 'completed')
  attachRunWebhook('http_runs', hr, uid, named)
  check('attach works out an enrichment\'s kind', events()[0]?.kind === 'enrichment', events())
  const sr = setupRun()
  set('setup_runs', sr, 'done')
  clearEvents()
  attachRunWebhook('setup_runs', sr, uid, named)
  check('... and a setup\'s, done as completed',
    events()[0]?.kind === 'setup' && events()[0]?.status === 'completed')
  clearEvents()
  db.prepare('DELETE FROM run_webhook_deliveries').run()
}

// --- webhook_id checks ---
check('no webhook_id is fine', webhookIdProblem(uid, undefined) === null && webhookIdProblem(uid, null) === null)
check('an unknown id is refused, saying where to find them',
  /list_run_webhooks/.test(webhookIdProblem(uid, 'nope') ?? ''))
check('another account\'s id is refused', webhookIdProblem(uid, someoneElse) !== null)
check('a non-string is refused', webhookIdProblem(uid, 42) !== null)

// --- A full queue logs instead of growing ---
{
  const ins = db.prepare(`INSERT INTO run_webhook_deliveries (id, user_id, webhook_id, event, body, state, next_try_at)
    VALUES (?, ?, ?, 'run.finished', '{}', 'pending', ?)`)
  db.transaction(() => {
    for (let i = 0; i < RUN_HOOK_MAX_WAITING; i++) ins.run(uuid(), uid, named, Date.now() + 3_600_000)
  })()
  const r = aiRun()
  db.prepare('UPDATE ai_runs SET webhook_id = ? WHERE id = ?').run(named, r)
  set('ai_runs', r, 'completed')
  fanOutRunEvents()
  const d = db.prepare('SELECT state, error FROM run_webhook_deliveries WHERE run_id = ? AND webhook_id = ?')
    .get(r, named) as { state: string; error: string }
  check('past the cap a notice is logged as not sent', d.state === 'failed' && /already waiting/.test(d.error), d)
  db.prepare('DELETE FROM run_webhook_deliveries').run()
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nrun hooks queue: all passed')

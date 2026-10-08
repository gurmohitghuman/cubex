// The enrichment ledger (services/enrich-ledger.ts) against a migrated
// throwaway DB: today's counter and each run's spend always equal the ledger
// after a mixed run (paid, unmetered, replays, refusals, another day); a
// replay whose first charge the ledger never saw records that charge; and the
// key history behind treg's replayed refusals.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import ledgerMod from '../../server/src/services/enrich-ledger'
import keyMod from '../../server/src/services/treg-key'
import metaMod from '../../server/src/lib/treg-meta'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { recordCall, runSpentMicro, seenCallId, keysUsed, keyUsedByOtherRun, heldKeys } =
  ledgerMod as typeof import('../../server/src/services/enrich-ledger')
const { spentTodayMicro } = keyMod as typeof import('../../server/src/services/treg-key')
const { readTregMeta } = metaMod as typeof import('../../server/src/lib/treg-meta')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?,?,?,?)').run(sheetId, tableId, uid, 'S')
const run = uuid(), other = uuid()
const insertRun = db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status)
  VALUES (?,?,?,'{}','running')`)
for (const id of [run, other]) insertRun.run(id, sheetId, uid)
interface Over {
  runId?: string; rowId?: string; attempt?: string; key?: string; status?: number;
  headers?: Record<string, string>; code?: string | null;
}
const call = (over: Over, now?: Date) =>
  recordCall({
    userId: uid, sheetId, runId: over.runId ?? run, rowId: over.rowId ?? 'r1', statusColumn: 'Email',
    toolId: 'treg.people.email.find', attempt: over.attempt ?? 'f1', idempotencyKey: over.key ?? 'k',
    httpStatus: over.status ?? 200, tregErrorCode: over.code ?? null, tier: null,
    meta: readTregMeta({ 'x-treg-call-id': 'c', ...(over.headers ?? {}) }),
  }, now)

const yesterday = new Date(Date.now() - 86_400_000)
check('a paid call returns its cost', call({ headers: { 'x-treg-cost-micro': '4834' } }).ledgerMicro === 4834)
call({ headers: { 'x-treg-cost-micro': '1500' }, attempt: 'v1' })
call({ headers: {} })                                                         // unmetered (own key)
const replayOf = (micro: string) => ({
  'x-treg-cost-micro': '0', 'x-treg-original-cost-micro': micro, 'x-treg-idempotent-replay': 'true',
})
const rp = call({ headers: replayOf('4834') })
check('a replay of a recorded charge is free, but the row counts it', rp.ledgerMicro === 0 && rp.rowMicro === 4834)
call({ status: 402, headers: { 'x-treg-error': '1' }, code: 'insufficient_balance' })
call({ runId: other, headers: { 'x-treg-cost-micro': '483' } })
call({ runId: other, headers: { 'x-treg-cost-micro': '9999' } }, yesterday)

const today = new Date().toISOString().slice(0, 10)
const daySum = db.prepare(`SELECT COALESCE(SUM(cost_micro),0) AS s FROM enrichment_calls
  WHERE user_id = ? AND substr(created_at,1,10) = ?`)
const ledgerToday = (daySum.get(uid, today) as { s: number }).s
check('today\'s counter equals the ledger sum for today',
  spentTodayMicro(uid) === ledgerToday && ledgerToday === 4834 + 1500 + 483)
check('yesterday is its own day', spentTodayMicro(uid, yesterday) === 9999)
check('a run\'s spend moves with its ledger',
  runSpentMicro(run, uid) === 6334 && runSpentMicro(other, uid) === 483 + 9999)
const unmetered = db.prepare(`SELECT cost_micro, treg_error, replay FROM enrichment_calls
  WHERE run_id = ? ORDER BY rowid`)
  .all(run) as Array<{ cost_micro: number | null; treg_error: string | null; replay: number }>
check('unmetered stays NULL, a replay is marked',
  unmetered[2].cost_micro === null && unmetered[3].replay === 1 && unmetered[3].cost_micro === 0)
check('a refusal keeps treg\'s code', unmetered[4].treg_error === 'insufficient_balance')

// A replay whose first answer never reached the ledger (restart, timeout).
const lost = call({ key: 'k-lost', attempt: 'f2', headers: replayOf('5000') })
check('a replay of a charge the ledger never saw records it once', lost.ledgerMicro === 5000 && lost.rowMicro === 5000)
check('... and a second replay of it is free',
  call({ key: 'k-lost', attempt: 'f2', headers: replayOf('5000') }).ledgerMicro === 0)
check('run spend and the day moved with it',
  runSpentMicro(run, uid) === 11334 && spentTodayMicro(uid) === 4834 + 1500 + 483 + 5000)
const recountToday = (daySum.get(uid, today) as { s: number }).s
check('the counter still equals the ledger', recountToday === spentTodayMicro(uid))

check('a call id seen under its key is a replay', seenCallId(uid, 'r1', 'k', 'c'))
check('another key or row is not', !seenCallId(uid, 'r1', 'other', 'c') && !seenCallId(uid, 'r2', 'k', 'c'))
call({ key: 'k2', attempt: 'f1.2', status: 401, headers: { 'x-treg-error': '1' } })
call({ key: 'k10', attempt: 'f10', status: 402, headers: { 'x-treg-error': '1' } })
check('keys used for f1 count f1 and f1.2, not f10', keysUsed(uid, 'r1', 'k', 'f1') === 2)
check('... only under the key prefix', keysUsed(uid, 'r1', 'x', 'f1') === 0)
check('another user sees nothing', keysUsed(uuid(), 'r1', 'k', 'f1') === 0 && runSpentMicro(run, uuid()) === 0)

// An auto-run's key is the same in its next run (enrich-step.ts keyScope).
const third = uuid()
insertRun.run(third, sheetId, uid)
call({ runId: other, rowId: 'r9', key: 'a-key', headers: { 'x-treg-cost-micro': '700' } })
const again = call({ runId: third, rowId: 'r9', key: 'a-key',
  headers: { 'x-treg-cost-micro': '0', 'x-treg-original-cost-micro': '700', 'x-treg-idempotent-replay': 'true' } })
check('a replay in the next run of a charge the ledger saw is free',
  again.ledgerMicro === 0 && runSpentMicro(third, uid) === 0)
check('the key was sent by another run', keyUsedByOtherRun(uid, 'r9', 'a-key', third))
check('... but not for the run that sent it alone', !keyUsedByOtherRun(uid, 'r1', 'k10', run))

// The keys a step already sent for one request, oldest first (enrich-step.ts walks them).
for (const [key, attempt] of [['cbx1:s:5:f1:fpA', 'f1'], ['cbx1:s:5:f1.2:fpA', 'f1.2'],
  ['cbx1:s:5:f1.3:fpB', 'f1.3'], ['cbx1:s:5:v1:fpA', 'v1'], ['cbx1:s:5:f1.4:fpA', 'f1.4']]) {
  call({ rowId: 'r5', key, attempt })
}
call({ rowId: 'r5', key: 'cbx1:s:5:f1.5:fpA', attempt: 'f1.5', status: 402, headers: { 'x-treg-error': '1' } })
call({ rowId: 'r5', key: 'cbx1:s:5:f1.6:fpA', attempt: 'f1.6', status: 409, headers: { 'x-treg-error': '1' } })
const held = heldKeys(uid, 'r5', 'cbx1:s:5:', 'f1', 'fpA').map(h => h.attempt).join()
check('held keys: this step and request, answered or still running, oldest first (a refusal left out)',
  held === 'f1,f1.2,f1.4,f1.6')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrichment ledger checks passed')

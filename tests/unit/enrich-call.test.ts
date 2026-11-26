// One enrichment tool called on items without a sheet (services/enrich-call.ts), on a migrated throwaway DB: the
// refusal that keeps a start from running halfway (no known price, max_cost_usd, today's limit, the treg balance,
// the token's spend cap), and the working table's column names (an output field keeps its name; an input or the
// status column that would share it is renamed, as for an email check, whose tool answers a "status" field); the
// call sweep stops an enrichment call paused longer than the keep time (its results then kept as long again).
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import callMod from '../../server/src/services/enrich-call'
import setupCallMod from '../../server/src/services/setup-call'
import tableMod from '../../server/src/services/table-crud'
import { passed } from './ends-on-its-own'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { callColumns, callRefusal } = callMod as typeof import('../../server/src/services/enrich-call')
const { sweepSetupCalls, STALE_PAUSE } = setupCallMod as typeof import('../../server/src/services/setup-call')
const { createTable } = tableMod as typeof import('../../server/src/services/table-crud')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
const token = (capUsd: number | null) => {
  const id = uuid()
  db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, spend_cap_micro)
    VALUES (?,?,?,?,?,?,?)`).run(id, uid, `Agent ${id.slice(0, 6)}`, `h-${id}`, 'cubex_pat_x', 'read,run',
    capUsd === null ? null : Math.round(capUsd * 1e6))
  return { userId: uid, tokenId: id, scopes: new Set(['read', 'run']) }
}
const est = (high: number | null, extra: Record<string, unknown> = {}) => ({
  price_known: high !== null, estimated_cost_usd: high === null ? null : { low: 0, high },
  may_pass_daily_limit: false, daily_limit: { remaining_usd: null }, ...extra,
})
const input = (extra: Record<string, unknown> = {}) => ({ toolId: 't', items: [], estimateOnly: false, ...extra })
const open = token(null)

check('a priced call under every limit starts', callRefusal(est(0.5), input({ maxCostUsd: 1 }), open) === null)
check('no known price: refused unless allow_unpriced',
  /allow_unpriced/.test(callRefusal(est(null), input(), open) ?? '')
  && callRefusal(est(null), input({ allowUnpriced: true }), open) === null)
check('over max_cost_usd: refused', /max_cost_usd/.test(callRefusal(est(2), input({ maxCostUsd: 1 }), open) ?? ''))
check('past today\'s limit: refused', /today's enrichment limit/.test(callRefusal(
  est(2, { may_pass_daily_limit: true, daily_limit: { remaining_usd: 1 } }), input(), open) ?? ''))
check('past the treg balance: refused', /treg balance/.test(callRefusal(
  est(2, { may_pass_balance: true }), input(), open) ?? ''))
const capped = token(1)
check('past the token\'s spend cap: refused, under it: starts',
  /spend cap/.test(callRefusal(est(2), input(), capped) ?? '') && callRefusal(est(0.5), input(), capped) === null)

// Column names on the working table.
const verify = callColumns(['email'], ['valid', 'status', 'score'])
check('a "status" field keeps its name; the status column moves aside', verify.status === 'Status 2'
  && verify.input.get('email') === 'email', { status: verify.status, input: [...verify.input] })
const same = callColumns(['domain', 'full_name'], ['domain', 'email'])
check('an input named like an output field gets " (input)"', same.input.get('domain') === 'domain (input)'
  && same.input.get('full_name') === 'full_name' && same.status === 'Status', { status: same.status,
  input: [...same.input] })

// An enrichment call left paused: kept for the keep time, then stopped (saying why), then removed as late again.
const made = createTable(uid, 'Enrichment call paused', { hidden: true })
if (!('ok' in made)) throw new Error(JSON.stringify(made))
const runId = uuid()
db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, updated_at)
  VALUES (?, ?, ?, '{}', 'paused', 'Status', datetime('now', '-23 hours'))`).run(runId, made.ok.sheetId, uid)
db.prepare('INSERT INTO enrichment_item_calls (id, user_id, table_id, sheet_id, items) VALUES (?, ?, ?, ?, 1)')
  .run(runId, uid, made.ok.id, made.ok.sheetId)
const run = () => db.prepare('SELECT status, error_message FROM http_runs WHERE id = ?').get(runId) as
  { status: string; error_message: string | null } | undefined
const tableKept = () => !!db.prepare('SELECT 1 FROM tables WHERE id = ? AND trash_id IS NULL').get(made.ok.id)
check('a call paused for less than the keep time stays paused', await sweepSetupCalls() === 0
  && run()?.status === 'paused' && tableKept(), run())
db.prepare("UPDATE http_runs SET updated_at = datetime('now', '-25 hours') WHERE id = ?").run(runId)
await sweepSetupCalls()
check('paused for longer: stopped, saying why, its working table kept', run()?.status === 'cancelled'
  && run()?.error_message === STALE_PAUSE && tableKept(), run())
db.prepare("UPDATE http_runs SET updated_at = datetime('now', '-25 hours') WHERE id = ?").run(runId)
check('then removed once its results have been kept as long', await sweepSetupCalls() === 1 && !tableKept())

if (failures > 0) { console.error(`${failures} enrich-call check(s) failed`); process.exit(1) }
console.log('enrich-call: all assertions passed')
passed()

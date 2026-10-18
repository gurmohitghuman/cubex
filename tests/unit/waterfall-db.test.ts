// Waterfall pieces that touch the DB, on a migrated throwaway DB: usage history
// (run_usage triggers, migration 038: a waterfall's mode, its AI cost, a dry
// run's column), the step-answer journal (kept, not kept, the AI cost on the
// run, dropped with the row, pruned past its keep), and the start request as
// the app and the agents send it (strict keys, snake_case to the app's shape,
// a step without an id keeping its column's step of the same label).
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import journalMod from '../../server/src/services/waterfall-journal'
import inputMod from '../../server/src/lib/waterfall/input'
import argsMod from '../../server/src/lib/waterfall/agent-args'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const J = journalMod as typeof import('../../server/src/services/waterfall-journal')
const { parseWaterfallInput } = inputMod as typeof import('../../server/src/lib/waterfall/input')
const { agentWaterfallBody } = argsMod as typeof import('../../server/src/lib/waterfall/agent-args')
type WaterfallRunConfig = import('../../server/src/lib/waterfall/config').WaterfallRunConfig

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

runMigrations()
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  .run(sid, tid, uid, 'Leads', 0, JSON.stringify(['Name', 'Domain', 'Email']))

const block = (extra: Record<string, unknown> = {}) => ({
  v: 1, resultType: 'email', inputs: [], steps: [], hideStepColumns: true, maxCostPerRowUsd: 0.05,
  tregCapPerRowUsd: 0.04, spendLimitUsd: 1, rows: { mode: 'all', status: 'any', test: null }, fresh: false, ...extra,
})
const config = (w: unknown) => JSON.stringify({
  requestConfig: { method: 'POST', url: '', body: '{}' }, responseMapping: [], previewSize: 5, waterfall: w,
})
const addRun = (id: string, column: string | null, cfg: string) =>
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?,'running',?)`).run(id, sid, uid, cfg, column)
const usage = (id: string) => db.prepare('SELECT * FROM run_usage WHERE run_id = ?').get(id) as Record<string, any>
const aiCost = (id: string) => db.prepare('SELECT ai_cost_usd FROM http_runs WHERE id = ?').pluck().get(id) as number

await check('usage: a waterfall run is an HTTP run of mode waterfall, its AI cost followed', () => {
  addRun('w1', 'Email', config(block()))
  assert.equal(usage('w1').kind, 'http')
  assert.equal(usage('w1').mode, 'waterfall')
  assert.equal(usage('w1').column_name, 'Email')
  db.prepare(`UPDATE http_runs SET ai_cost_usd = 0.0123, ai_provider_cost_usd = 0.004, processed_rows = 3,
    spent_micro = 20000 WHERE id = 'w1'`).run()
  const u = usage('w1')
  assert.equal(u.ai_cost_usd, 0.0123)
  assert.equal(u.provider_cost_usd, 0.004)
  assert.equal(u.cells, 3)
  assert.equal(u.enrich_micro, 20000)
})

await check('usage: a plain HTTP run has no mode and keeps its own AI cost columns', () => {
  addRun('h1', 'Lookup', JSON.stringify({ requestConfig: { method: 'GET', url: 'https://x.io' }, responseMapping: [] }))
  assert.equal(usage('h1').mode, null)
  db.prepare("UPDATE http_runs SET ai_cost_usd = 5 WHERE id = 'h1'").run()
  assert.equal(usage('h1').ai_cost_usd, 0)
})

await check('usage: a dry run counts under the column it was started for', () => {
  addRun('d1', null, config(block({ dry: { column: 'Email', only: null } })))
  assert.equal(usage('d1').column_name, 'Email')
  assert.equal(usage('d1').mode, 'waterfall')
})

const ref = (rowRef: string, stepKey = 'k1') => ({ userId: uid, scope: 'w1', rowRef, stepKey })
const answer = { outcome: 'answered' as const, value: 'ada@acme.example', costUsd: 0.002, aiProviderUsd: 0 }

await check('journal: a finished step is kept and found; its AI cost lands on the run and in usage', () => {
  const before = aiCost('w1')
  J.keepAnswer(ref('r1'), 'w1', answer, { ai: true, keep: true })
  const kept = J.findKeptAnswer(ref('r1'))
  assert.equal(kept?.run.value, 'ada@acme.example')
  assert.equal(kept?.runId, 'w1')
  assert.ok(Math.abs(aiCost('w1') - before - 0.002) < 1e-9)
  assert.ok(Math.abs(usage('w1').ai_cost_usd - aiCost('w1')) < 1e-9)
  assert.equal(J.findKeptAnswer(ref('r1', 'other')), null)
  assert.equal(J.findKeptAnswer({ ...ref('r1'), scope: 'w2' }), null)
})

await check('journal: an error or a skip is never kept (a resume tries it again), its cost still counts', () => {
  const before = aiCost('w1')
  J.keepAnswer(ref('r2'), 'w1', { outcome: 'error', value: '', costUsd: 0.001 }, { ai: true, keep: true })
  J.keepAnswer(ref('r2', 'k2'), 'w1', { outcome: 'no_inputs', value: '', costUsd: 0 }, { ai: false, keep: true })
  assert.equal(J.findKeptAnswer(ref('r2')), null)
  assert.equal(J.findKeptAnswer(ref('r2', 'k2')), null)
  assert.ok(Math.abs(aiCost('w1') - before - 0.001) < 1e-9)
})

await check('journal: keep false records the AI cost only', () => {
  const before = aiCost('w1')
  J.keepAnswer(ref('r4'), 'w1', answer, { ai: true, keep: false })
  assert.equal(J.findKeptAnswer(ref('r4')), null)
  assert.ok(Math.abs(aiCost('w1') - before - 0.002) < 1e-9)
})

await check('journal: the row\'s write drops its answers, other rows keep theirs', () => {
  J.keepAnswer(ref('r3'), 'w1', answer, { ai: false, keep: true })
  J.dropRowAnswers(uid, 'w1', 'r1')
  assert.equal(J.findKeptAnswer(ref('r1')), null)
  assert.ok(J.findKeptAnswer(ref('r3')))
})

await check('journal: answers past their keep are not found and are pruned', () => {
  db.prepare(`INSERT INTO waterfall_step_answers (user_id,scope,row_ref,step_key,run_id,outcome,cost_usd,created_at)
    VALUES (?,?,?,?,?,?,0,?)`).run(uid, 'w1', 'old', 'k1', 'w1', JSON.stringify(answer), '2020-01-01T00:00:00.000Z')
  assert.equal(J.findKeptAnswer(ref('old')), null)
  assert.equal(J.pruneKeptAnswers(uid), 1)
  assert.ok(J.findKeptAnswer(ref('r3')))
})

const httpStep = { kind: 'http', url: 'https://api.example.com/find?d={{domain}}', valuePath: '$.email' }
const appBody = {
  columnName: 'Email', resultType: 'email', inputs: [{ key: 'domain', label: 'Company domain',
    source: { column: 'Domain' } }], steps: [{ label: 'Own API', choices: httpStep }],
}

await check('start request: a minimal one parses with its defaults', () => {
  const r = parseWaterfallInput(appBody)
  assert.ok('ok' in r, JSON.stringify(r))
  assert.equal(r.ok.answeredBy, true)
  assert.equal(r.ok.hideStepColumns, true)
  assert.equal(r.ok.rows.status, 'any')
  assert.equal(r.ok.steps[0].on, true)
  assert.equal(r.ok.steps[0].requires, null)
  assert.equal(r.ok.dry, null)
})

await check('start request: unknown keys at any level are refused, never dropped', () => {
  const top = parseWaterfallInput({ ...appBody, estimateOnly: true })
  assert.ok('error' in top && top.error.includes('estimateOnly'), JSON.stringify(top))
  const inStep = parseWaterfallInput({ ...appBody, steps: [{ choices: { ...httpStep, verb: 'GET' } }] })
  assert.ok('error' in inStep && inStep.error.includes('verb'), JSON.stringify(inStep))
  assert.ok('error' in parseWaterfallInput({ ...appBody, resultType: 'fax' }))
  assert.ok('error' in parseWaterfallInput({ ...appBody, steps: [{ choices: httpStep, requires: [[]] }] }))
  assert.ok('error' in parseWaterfallInput({ ...appBody, spendLimitUsd: 0 }))
})

const prior = {
  waterfall: { steps: [{ id: 'sabc123', label: 'Own API' }, { id: 'sdef456', label: 'Other' }] },
} as unknown as WaterfallRunConfig
const noTarget = { rowIndexes: null, generation: null }

await check('agent arguments: snake_case to the app\'s shape, a step keeps its column\'s id by label', () => {
  const r = agentWaterfallBody({
    sheet_id: sid, column_name: 'Email', result_type: 'email', inputs: { domain: 'Domain', full_name: null },
    steps: [{ kind: 'http', label: 'own api', url: httpStep.url, value_path: '$.email' }], test: true,
  }, prior, null, noTarget)
  assert.ok('ok' in r, JSON.stringify(r))
  const body = r.ok as any
  assert.deepEqual(body.inputs, [{ key: 'domain', label: 'Company domain', source: { column: 'Domain' } },
    { key: 'full_name', label: 'Full name', source: null }])
  assert.equal(body.steps[0].id, 'sabc123')
  assert.deepEqual(body.steps[0].choices, { kind: 'http', url: httpStep.url, valuePath: '$.email' })
  assert.deepEqual(body.rows, { mode: 'all', status: 'any', test: 5 })
  const parsed = parseWaterfallInput(JSON.parse(JSON.stringify(body)))
  assert.ok('ok' in parsed, JSON.stringify(parsed))
})

await check('agent arguments: control_run\'s row words, misspellings refused, add_to needs a waterfall', () => {
  const recalled = parseWaterfallInput(appBody)
  assert.ok('ok' in recalled)
  const cont = agentWaterfallBody({ column_name: 'Email', add_to_column: true, rows: 'errored' }, prior,
    recalled.ok, noTarget)
  assert.ok('ok' in cont && (cont.ok as any).rows.status === 'failed', JSON.stringify(cont))
  const byDefault = agentWaterfallBody({ column_name: 'Email', add_to_column: true }, prior, recalled.ok, noTarget)
  assert.ok('ok' in byDefault && (byDefault.ok as any).rows.status === 'not_enriched')
  const typo = agentWaterfallBody({ column_name: 'Email', estimate_onyl: true }, null, null, noTarget)
  assert.ok('error' in typo && typo.error.includes('estimate_onyl'), JSON.stringify(typo))
  assert.ok('error' in agentWaterfallBody({ column_name: 'Nope', add_to_column: true }, null, null, noTarget))
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('waterfall-db: all checks passed')

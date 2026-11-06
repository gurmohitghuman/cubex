// Over 200 lines: one ceiling, checked at the call and at each step, on one stand-in and sheet.
// A setup's cost ceiling (apply_setup max_cost_usd): checked at the call
// against the estimate (services/setup-apply.ts) and, once it runs, each
// spending step's limit as it starts (services/setup-ceiling.ts), on a
// migrated throwaway DB with OpenRouter's model list served by a stand-in:
//   - a free setup (clean and formula) passes a $0.01 ceiling;
//   - an AI step priced over the ceiling, or with no known price and no
//     allow_unpriced, is refused with the estimate: nothing is created (no
//     setup_runs record, no run, no column); estimate_only says so instead;
//   - the ceiling also holds one row's most for each AI step (its run's spend
//     limit starts a row only while that fits): under it, refused with both
//     figures; covering it, it goes ahead;
//   - each AI step starts with the ceiling less what the steps started spent or
//     may still spend, less what the steps not started need (their high ends
//     and an AI step's row most); a step with no price gets no limit; one left
//     no room (for its high end and its row most) is refused with words;
//   - an earlier AI step's calls cut off before they answered count as spent.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const pricing = { prompt: '0.00001', completion: '0.00003' }
    res.end(JSON.stringify({ data: [{ id: 'test/priced', name: 'p', pricing },
      { id: 'test/varies', name: 'v', pricing: { prompt: '-1', completion: '-1' } }] }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { insertSetup } = await import('../../server/src/services/setup-library')
const { applySetup } = await import('../../server/src/services/setup-apply')
const { applyInputOf } = await import('../../server/src/services/setup-apply-input')
const { insertSetupRun, loadSetupRun } = await import('../../server/src/services/setup-run-store')
const { stepGate, setupCeilingOf } = await import('../../server/src/services/setup-ceiling')
type Spec = import('../../server/src/lib/setups/spec').SetupSpec
type Step = import('../../server/src/services/setup-run-store').StepRecord
runMigrations()
console.warn = () => {}

const ok = (label: string) => console.log('ok  ', label)
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
const sid = uuid()
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'People', JSON.stringify(['Name']))
for (let i = 0; i < 5; i++) {
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), sid, uid, i, JSON.stringify({ Name: `  Person ${i} ` }))
}
const count = (sql: string) => db.prepare(sql).pluck().get() as number
const columns = () => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(sid) as string)

const ai = (name: string, model: string) => ({
  kind: 'ai' as const, name, prompt: 'Describe /name', systemPrompt: null, model, temperature: 0.7, maxChars: null,
  concurrency: null, webSearch: false, webFetch: false, search: null, outputColumns: null, runIf: null,
})
const free: Spec = { v: 1, inputs: ['Name'], keys: [], steps: [
  { kind: 'clean', name: 'Trimmed', source: 'Name', cleaner: 'trim', options: {}, autoRun: false },
  { kind: 'formula', name: 'Len', formula: '{{Trimmed}}.length', description: null, autoRun: false },
] }
const setupOf = (name: string, spec: Spec) => {
  const s = insertSetup(uid, name, null, spec)
  if (!('ok' in s)) throw new Error(JSON.stringify(s))
  return s.ok.id
}
const input = (b: Record<string, unknown>) => {
  const i = applyInputOf(b, 'v1')
  if ('fail' in i) throw new Error(i.message)
  return i
}
const apply = (setupId: string, b: Record<string, unknown>) =>
  applySetup(uid, sid, setupId, input(b), { hasSecretsScope: true })

// --- At the call ---------------------------------------------------------------------
assert.ok('fail' in applyInputOf({ max_cost_usd: 0 }, 'v1'))
assert.ok('fail' in applyInputOf({ maxCostUsd: 1, allowUnpriced: 'maybe' }, 'app'))
assert.deepEqual((applyInputOf({ maxCostUsd: 1, allowUnpriced: true }, 'app') as { maxCostUsd: number }).maxCostUsd, 1)
ok('max_cost_usd and allow_unpriced are read and checked (maxCostUsd and allowUnpriced from the app)')

const freeId = setupOf('Free', free)
const freeEst = await apply(freeId, { estimate_only: true, max_cost_usd: 0.01 })
assert.ok('ok' in freeEst && 'estimate' in freeEst.ok)
assert.equal(freeEst.ok.estimate.over_ceiling, false)
assert.equal(freeEst.ok.estimate.ceiling_problem, null)
assert.equal(freeEst.ok.estimate.max_cost_usd, 0.01)
ok('a free setup (clean and formula) passes a $0.01 ceiling')

const pricedId = setupOf('Priced', { v: 1, inputs: ['Name'], keys: [], steps: [ai('Fit', 'test/priced')] })
const est = await apply(pricedId, { estimate_only: true, max_cost_usd: 0.000001 })
assert.ok('ok' in est && 'estimate' in est.ok)
assert.equal(est.ok.estimate.over_ceiling, true)
assert.match(est.ok.estimate.ceiling_problem ?? '', /more than the \$0\.000001 ceiling/)
const refused = await apply(pricedId, { max_cost_usd: 0.000001 })
assert.ok('fail' in refused && refused.fail === 'over_ceiling')
assert.match(refused.message, /^It could cost up to \$[\d.]+, and its spend limit starts a row only while the row's /)
assert.match(refused.message, /more than the \$0\.000001 ceiling \(max_cost_usd\)/)
assert.equal((refused.estimate as { over_ceiling: boolean }).over_ceiling, true)
assert.equal(count('SELECT COUNT(*) FROM setup_runs'), 0)
assert.equal(count('SELECT COUNT(*) FROM ai_runs'), 0)
assert.deepEqual(columns(), ['Name'])
ok('an AI step over the ceiling: estimate_only says over_ceiling, a start is refused and creates nothing')

// One row's most for the AI step: its prompt's bytes and 8,000 output tokens at $30/M, about $0.24.
const fit = est.ok.estimate
const high = fit.high_usd, most = fit.row_most_usd
assert.equal(fit.steps[0].row_most_usd, most)
assert.ok(most > 0.24 && most < 0.25 && most > high, `row most ${most}, high ${high}`)
const short = await apply(pricedId, { max_cost_usd: Math.round((high + most / 2) * 1e6) / 1e6 })
assert.ok('fail' in short && short.fail === 'over_ceiling')
assert.match(short.message, /needs room for one row at its most on top \(up to \$0\.24\): \$0\.\d+ in all, more than/)
assert.equal(count('SELECT COUNT(*) FROM setup_runs'), 0)
const covers = await apply(pricedId, { estimate_only: true, max_cost_usd: Math.ceil((high + most) * 1e6) / 1e6 })
assert.ok('ok' in covers && 'estimate' in covers.ok && covers.ok.estimate.over_ceiling === false)
const twoId = setupOf('Two', {
  v: 1, inputs: ['Name'], keys: [], steps: [ai('P', 'test/priced'), ai('Q', 'test/priced')],
})
const two = await apply(twoId, { estimate_only: true, max_cost_usd: Math.ceil((2 * high + most) * 1e6) / 1e6 })
assert.ok('ok' in two && 'estimate' in two.ok)
assert.equal(two.ok.estimate.row_most_usd, Math.round(2 * most * 1e6) / 1e6)
assert.match(two.ok.estimate.ceiling_problem ?? '', /one row at its most for each of its 2 AI steps on top/)
ok("the ceiling holds one row's most for each AI step: under it refused with both figures, covering it fine")

// A negative listed price (one that varies) is no known price; a routing variant is priced as its model.
const unpricedId = setupOf('Unpriced', { v: 1, inputs: ['Name'], keys: [], steps: [ai('Guess', 'test/varies')] })
const noPrice = await apply(unpricedId, { max_cost_usd: 100 })
assert.ok('fail' in noPrice && noPrice.fail === 'over_ceiling')
assert.match(noPrice.message, /No price is known for "Guess \(Output\)".*allow_unpriced: true/)
const allowed = await apply(unpricedId, { estimate_only: true, max_cost_usd: 100, allow_unpriced: true })
assert.ok('ok' in allowed && 'estimate' in allowed.ok && allowed.ok.estimate.over_ceiling === false)
assert.equal(count('SELECT COUNT(*) FROM setup_runs'), 0)
const nitroId = setupOf('Nitro', { v: 1, inputs: ['Name'], keys: [], steps: [ai('Fast', 'test/priced:nitro')] })
const nitro = await apply(nitroId, { estimate_only: true, max_cost_usd: 100 })
assert.ok('ok' in nitro && 'estimate' in nitro.ok && nitro.ok.estimate.unpriced.length === 0)
assert.equal(nitro.ok.estimate.over_ceiling, false)
ok('a step with no known price: refused without allow_unpriced, let through with it; :nitro is priced')

// --- Each step's limit as it starts ------------------------------------------------
// Three AI steps (A and B side by side, then C) under a $1 ceiling, estimated at $0.20, $0.30 and $0.10.
const chain: Spec = { v: 1, inputs: ['Name'], keys: [], steps: [ai('A', 'test/priced'), ai('B', 'test/priced'),
  { ...ai('C', 'test/priced'), prompt: 'Use /a_output' }, { kind: 'clean', name: 'T', source: 'Name', cleaner: 'trim',
    options: {}, autoRun: false }] }
const ceiling = setupCeilingOf({ rows: 5, low_usd: 0, high_usd: 0.6, unpriced: [], steps: [
  { high_usd: 0.2 }, { high_usd: 0.3 }, { high_usd: 0.1 }, { high_usd: null, free: true },
] } as never, { maxCostUsd: 1, allowUnpriced: false })
assert.deepEqual(ceiling,
  { maxCostUsd: 1, allowUnpriced: false, highUsd: [0.2, 0.3, 0.1, 0], rowMostUsd: [0, 0, 0, 0] })
const rec = insertSetupRun({ userId: uid, sheetId: sid, setupId: pricedId, setupName: 'Chain',
  plan: { spec: chain, layers: [0, 0, 1, 0], ceiling }, targetRowIds: null, allowSecrets: true, autoRun: false })
const r = () => loadSetupRun(rec)!
const waiting = (): Step[] => chain.steps.map(() => ({ state: 'waiting' }))
const aiRun = (status: string, limit: number | null, spent: number) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, spend_limit_usd)
    VALUES (?,?,?,'X (Output)','p','test/priced',?,?)`).run(id, sid, uid, status, limit)
  db.prepare('UPDATE run_usage SET ai_cost_usd = ? WHERE run_id = ?').run(spent, id)
  return id
}
const near = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 1e-9

let gate = stepGate(r(), 0, waiting())
assert.ok('limitUsd' in gate && near(gate.limitUsd, 0.6), JSON.stringify(gate))
ok('the first step gets the ceiling less the high ends of the steps not started ($1 - $0.30 - $0.10)')

const a = aiRun('running', 0.6, 0.05)
const steps = waiting()
steps[0] = { state: 'running', kind: 'ai', runId: a }
gate = stepGate(r(), 1, steps)
assert.ok('limitUsd' in gate && near(gate.limitUsd, 0.3), JSON.stringify(gate))
ok('a step beside a running one: that one counts at its own limit, so this gets its own high end ($0.30)')

db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(a)
db.prepare('UPDATE run_usage SET ai_cost_usd = 0.15 WHERE run_id = ?').run(a)
steps[0] = { state: 'done', kind: 'ai', runId: a }
steps[1] = { state: 'done', kind: 'ai', runId: aiRun('completed', 0.3, 0.25) }
gate = stepGate(r(), 2, steps)
assert.ok('limitUsd' in gate && near(gate.limitUsd, 0.6), JSON.stringify(gate))
ok('a later step gets what the finished ones left ($1 - $0.15 - $0.25)')

steps[1] = { state: 'done', kind: 'ai', runId: aiRun('completed', null, 0.8) }
gate = stepGate(r(), 2, steps)
assert.ok('refused' in gate)
assert.match(gate.refused, /^it could cost up to \$0\.10, and \$0\.95 of the \$1\.00 ceiling is spent or held\. Stop/)
assert.match(gate.refused, /and the new ceiling counts only what it spends from then on\.$/)
steps[1] = { state: 'done', kind: 'ai', runId: aiRun('completed', null, 0.75) }
gate = stepGate(r(), 2, steps)
assert.ok('limitUsd' in gate && near(gate.limitUsd, 0.1), JSON.stringify(gate))
ok('a step whose high end no longer fits is refused, saying what is spent and held; one that just fits starts')

assert.deepEqual(stepGate(r(), 3, steps), { limitUsd: null })
const noPriceRec = insertSetupRun({ userId: uid, sheetId: sid, setupId: pricedId, setupName: 'Chain',
  plan: { spec: chain, layers: [0, 0, 1, 0], ceiling: { ...ceiling, highUsd: [null, 0.3, 0.1, 0] } },
  targetRowIds: null, allowSecrets: true, autoRun: false })
assert.deepEqual(stepGate(loadSetupRun(noPriceRec)!, 0, waiting()), { limitUsd: null })
const plainRec = insertSetupRun({ userId: uid, sheetId: sid, setupId: pricedId, setupName: 'Chain',
  plan: { spec: chain, layers: [0, 0, 1, 0] }, targetRowIds: null, allowSecrets: true, autoRun: false })
assert.deepEqual(stepGate(loadSetupRun(plainRec)!, 0, waiting()), { limitUsd: null })
ok('a free step, a step with no price, and a setup without a ceiling: no limit')

// Each AI step also needs one row at its most ($0.05 here): steps not started hold theirs too.
const withMost = { ...ceiling, rowMostUsd: [0.05, 0.05, 0.05, 0] }
const mostRec = insertSetupRun({ userId: uid, sheetId: sid, setupId: pricedId, setupName: 'Chain',
  plan: { spec: chain, layers: [0, 0, 1, 0], ceiling: withMost }, targetRowIds: null, allowSecrets: true,
  autoRun: false })
gate = stepGate(loadSetupRun(mostRec)!, 0, waiting())
assert.ok('limitUsd' in gate && near(gate.limitUsd, 0.5), JSON.stringify(gate))
const late = waiting()
late[0] = { state: 'done', kind: 'ai', runId: aiRun('completed', null, 0.5) }
late[1] = { state: 'done', kind: 'ai', runId: aiRun('completed', null, 0.36) }
gate = stepGate(loadSetupRun(mostRec)!, 2, late)
assert.ok('refused' in gate, 'left $0.14: its $0.10 fits, but not with one row at its most')
assert.match(gate.refused, /^it could cost up to \$0\.10, and its spend limit needs room for one row at its most on /)
late[1] = { state: 'done', kind: 'ai', runId: aiRun('completed', null, 0.35) }
gate = stepGate(loadSetupRun(mostRec)!, 2, late)
assert.ok('limitUsd' in gate && near(gate.limitUsd, 0.15), JSON.stringify(gate))
ok("each AI step needs its high end and one row's most: the first gets $1 - $0.35 - $0.15; a late one needs both")

// An earlier AI step's calls cut off before they answered may be billed: their most counts as spent.
const cut = waiting()
cut[0] = { state: 'done', kind: 'ai', runId: aiRun('completed', 0.6, 0.15) }
cut[1] = { state: 'done', kind: 'ai', runId: aiRun('completed', 0.3, 0.25) }
db.prepare('UPDATE ai_runs SET spend_cut_off_micro = 100000 WHERE id = ?').run(cut[1].runId)
gate = stepGate(r(), 2, cut)
assert.ok('limitUsd' in gate && near(gate.limitUsd, 0.5), JSON.stringify(gate))
cut[1] = { state: 'running', kind: 'ai', runId: aiRun('running', 0.3, 0.25) }
db.prepare('UPDATE ai_runs SET spend_cut_off_micro = 100000 WHERE id = ?').run(cut[1].runId)
gate = stepGate(r(), 2, cut)
// Past its own limit with them: it counts what it spent and they hold, not its limit.
assert.ok('limitUsd' in gate && near(gate.limitUsd, 0.5), JSON.stringify(gate))
ok("an earlier AI step's cut-off calls count as spent: $1 - $0.15 - ($0.25 + $0.10), also while it runs")

server.close()

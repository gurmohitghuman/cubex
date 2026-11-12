// Who paid for each AI row and what it used (migration 055), against a stand-in for OpenRouter
// (ai-spend-kit.ts) that answers each call with the usage it is told to:
//   - usage parsing: is_byok true is the user's own key, false OpenRouter's credits, absent unknown; the
//     reasoning tokens of both APIs; an own-key call whose upstream total is null is priced from its two parts;
//   - a run's rows keep their payer and reasoning tokens; get_run_results returns paid_with and
//     tokens {input, output, reasoning}, with provider_cost_usd null on an own-key row OpenRouter didn't price;
//     the run's summary counts rows per payer, so a fall back to credits shows; rows from before stay null;
//   - the estimate's own-key guess reads paid_with, and both the estimate and a preview on the user's own key
//     report in_flight (OpenRouter can still hold in-flight budget for those rows);
//   - preview rows say who paid and their tokens, with notes for an unpriced own-key row and a fall back.
import assert from 'node:assert/strict'
import { endsWithin, OUT, PRICED, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, runOf, sheetOf } = w
const { usageOf, completionFromResponse } = await import('../../server/src/lib/responses-adapter')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { getAiRunResults, getAiRunSummary } = await import('../../server/src/services/run-status')
const { ranOnOwnKey } = await import('../../server/src/services/ai-token-history')
const { estimateAiRun } = await import('../../server/src/services/run-estimate')
const { previewAiRun } = await import('../../server/src/services/run-preview')
const stop = (runId: string) => () => db.prepare("UPDATE ai_runs SET status = 'paused' WHERE id = ?").run(runId)
// Runs made in one second tie on created_at: give each its own, in order.
let second = 0
const stamp = (runId: string) => db.prepare("UPDATE ai_runs SET created_at = datetime('2026-01-01', ?) WHERE id = ?")
  .run(`+${++second} seconds`, runId)
const run = async (n: number) => {
  const r = runOf(n, 1, null, PRICED)
  stamp(r.runId)
  await endsWithin(processAIRun(r.runId, 0), 20_000, stop(r.runId))
  return r
}
const results = (runId: string) => getAiRunResults(runId, uid, -1, 50, 'all')!.results as Array<Record<string, any>>
const OWN = { is_byok: true, cost: 0.00001, completion_tokens_details: { reasoning_tokens: 7 },
  cost_details: { upstream_inference_cost: null, upstream_inference_prompt_cost: 0.0001,
    upstream_inference_completions_cost: 0.0002 } }
const CREDITS = { is_byok: false, cost: 0.0003, cost_details: { upstream_inference_cost: null } }

await ok('usage: who paid, reasoning tokens, and an own-key total priced from its parts', () => {
  const chat = usageOf({ usage: { prompt_tokens: 3, completion_tokens: 9, ...OWN } })
  assert.deepEqual(chat, { promptTokens: 3, completionTokens: 9, reasoningTokens: 7, costUsd: 0.00001,
    providerCostUsd: 0.0003, paidWith: 'own_key' })
  const responses = usageOf(completionFromResponse({ status: 'completed', output: [], usage: {
    input_tokens: 4, output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 }, cost: 0, is_byok: true,
    cost_details: { upstream_inference_cost: null, upstream_inference_input_cost: 0.5,
      upstream_inference_output_cost: 1 },
  } }))
  assert.equal(responses.reasoningTokens, 2)
  assert.equal(responses.providerCostUsd, 1.5)
  assert.equal(responses.paidWith, 'own_key')
  assert.equal(usageOf({ usage: { cost: 0.01, is_byok: false } }).paidWith, 'credits')
  assert.equal(usageOf({ usage: { cost: 0.01 } }).paidWith, null, 'no is_byok: unknown')
  // A stated total wins over its parts; credits never carry a provider charge.
  assert.equal(usageOf({ usage: { is_byok: true, cost_details: { upstream_inference_cost: 0.25,
    upstream_inference_prompt_cost: 1, upstream_inference_completions_cost: 1 } } }).providerCostUsd, 0.25)
  assert.equal(usageOf({ usage: { is_byok: false, cost_details: { upstream_inference_prompt_cost: 1,
    upstream_inference_completions_cost: 1 } } }).providerCostUsd, null)
  assert.equal(usageOf({ usage: { is_byok: true, cost_details: { upstream_inference_prompt_cost: 1 } } })
    .providerCostUsd, null, 'one part alone is no total')
})

let mixedRun = ''
await ok("a run's rows keep who paid and their tokens; its summary counts rows per payer", async () => {
  stand.usage = n => (n % 2 === 1 ? OWN : CREDITS)
  stand.calls = 0
  const { runId } = await run(4)
  mixedRun = runId
  const rows = results(runId)
  assert.deepEqual(rows.map(r => r.paid_with), ['own_key', 'credits', 'own_key', 'credits'])
  assert.deepEqual(rows[0].tokens, { input: 3, output: 1, reasoning: 7 })
  assert.deepEqual(rows[1].tokens, { input: 3, output: 1, reasoning: null })
  assert.equal(rows[0].provider_cost_usd, 0.0003)
  assert.equal('provider_cost_usd' in rows[1], false, 'a credits row has no provider charge')
  assert.deepEqual(Object.keys(rows[0]), ['row_id', 'row_index', 'status', 'value', 'error_message', 'cost_usd',
    'provider_cost_usd', 'paid_with', 'tokens'])
  const summary = getAiRunSummary(runId, uid)!
  assert.deepEqual(summary.rows_paid_with, { own_key: 2, credits: 2 })
  assert.equal(summary.provider_cost_usd, 0.0006)
  const stored = db.prepare(`SELECT paid_with, reasoning_tokens FROM ai_results WHERE run_id = ?
    ORDER BY row_index`).all(runId)
  assert.deepEqual(stored[0], { paid_with: 'own_key', reasoning_tokens: 7 })
})

await ok("an own-key row OpenRouter didn't price says so: provider_cost_usd null", async () => {
  stand.usage = () => ({ is_byok: true, cost: 0.00002 })
  const { runId } = await run(2)
  const rows = results(runId)
  assert.deepEqual(rows.map(r => [r.paid_with, r.provider_cost_usd]), [['own_key', null], ['own_key', null]])
  const summary = getAiRunSummary(runId, uid)!
  assert.deepEqual(summary.rows_paid_with, { own_key: 2, credits: 0 })
  assert.equal('provider_cost_usd' in summary, false)
  // The latest run on the model ran on the own key, though OpenRouter sent no provider cost.
  assert.equal(ranOnOwnKey(uid, PRICED), true)
})

await ok('both the estimate and a preview on the own key report in_flight, with a note saying why', async () => {
  const sid = sheetOf(3)
  const est = await estimateAiRun(uid, { sheetId: sid, prompt: 'Say hi to /name', model: PRICED, maxChars: null,
    concurrency: 4 })
  assert.ok('ok' in est)
  assert.equal(est.ok.own_provider_key, true)
  assert.equal(est.ok.in_flight?.concurrency, 4)
  assert.match(est.ok.in_flight!.note, /OpenRouter can hold in-flight budget on an own-key run too/)
  // One row on the own key with its provider's charge (what used to hide in_flight), one OpenRouter didn't
  // price, one that fell back to credits.
  stand.usage = n => (n === 1 ? OWN : n === 2 ? { is_byok: true, cost: 0.00001 } : CREDITS)
  stand.calls = 0
  const prev = await previewAiRun(uid, { sheetId: sid, prompt: 'Say hi to /name', model: PRICED, maxChars: null,
    previewRows: 3, concurrency: 4 })
  assert.ok('ok' in prev, JSON.stringify(prev))
  const p = prev.ok as Record<string, any>
  const priced = p.preview.find((r: any) => r.provider_cost_usd === 0.0003)
  const unpriced = p.preview.find((r: any) => r.paid_with === 'own_key' && r.provider_cost_usd === null)
  const credits = p.preview.find((r: any) => r.paid_with === 'credits')
  assert.ok(priced && unpriced && credits, JSON.stringify(p.preview))
  assert.deepEqual(Object.keys(unpriced).slice(-4), ['cost_usd', 'provider_cost_usd', 'paid_with', 'tokens'])
  assert.deepEqual(priced.tokens, { input: 3, output: 1, reasoning: 7 })
  assert.deepEqual(credits.tokens, { input: 3, output: 1, reasoning: null })
  assert.equal('provider_cost_usd' in credits, false)
  assert.equal(p.provider_cost.per_row_usd, 0.0001, "the own key's charge, over the 3 rows")
  assert.equal(p.in_flight?.concurrency, 4, 'in_flight with rows on the own key')
  assert.match(p.note, /OpenRouter didn't say what your provider charged for 1 row/)
  assert.match(p.note, /Some rows were paid with OpenRouter credits/)
})

await ok('the own-key guess follows paid_with: a latest run paid with credits is not an own-key run', async () => {
  stand.usage = () => CREDITS
  await run(1)
  assert.equal(ranOnOwnKey(uid, PRICED), false)
})

await ok('rows from before migration 055 read back with null payer and reasoning tokens', () => {
  const { sid, runId } = runOf(1, 1, null, PRICED)
  db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, prompt_tokens,
    completion_tokens, cost_usd) VALUES ('old-row', ?, ?, 0, 'x', 'completed', 11, 5, 0.001)`).run(runId, uid)
  const [row] = results(runId)
  assert.equal(row.paid_with, null)
  assert.deepEqual(row.tokens, { input: 11, output: 5, reasoning: null })
  assert.equal('provider_cost_usd' in row, false)
  assert.equal('rows_paid_with' in getAiRunSummary(runId, uid)!, false)
  assert.ok(sid && mixedRun)
})

await ok("the summary's per-payer count stays one index-only scan", () => {
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT status, COUNT(*) AS n, SUM(cost_usd) AS cost,
    COUNT(cost_usd) AS priced, SUM(web_searches) AS searches, SUM(provider_cost_usd) AS provider,
    COUNT(provider_cost_usd) AS byok, SUM(paid_with = 'own_key') AS own_key, SUM(paid_with = 'credits') AS credits
    FROM ai_results WHERE run_id = ? GROUP BY status`).all(mixedRun) as Array<{ detail: string }>
  assert.match(plan.map(p => p.detail).join(' | '), /USING COVERING INDEX idx_ai_results_run_payer/)
})

void OUT
stand.close()
w.done()
console.log('ai-run-costs-payer: ok')
process.exit(0)

// An AI run's prices for its spend limit and its ceiling, against a stand-in
// for OpenRouter (ai-spend-kit.ts) whose model list starts cold (this process
// has read none yet):
//   - a model list that can't be read is tried again, then the run pauses
//     (provider_errors) before any call, never running a priced model as
//     unpriced; a read that works on a later try lets it run; a resume retries;
//   - a negative listed price (openrouter/auto's "-1") is no listed price, in
//     the run and in the estimate;
//   - the estimate prices a routing variant as its model, as the run does, and
//     names one row's most (row_most_usd) exactly as the run holds it;
//   - a ceiling under the high end plus one row's most is refused at the start
//     (such a run would stop before its rows); one that covers both runs every row;
//   - a resume refused for another reason keeps the old limit.
import assert from 'node:assert/strict'
import { endsWithin, FEE_VARIES, PRICED, startStandIn, VARIES, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, runOf, sheetOf, cells, runRow, holds, runById, PLACEHOLDER } = w
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { resumeAiRun } = await import('../../server/src/services/ai-run-limit')
const { rowFixedOf } = await import('../../server/src/services/ai-spend-gate')
const { rowMaxMicro, PRICE_UNREAD_MESSAGE } = await import('../../server/src/lib/ai-spend-limit')
const { estimateAiRun } = await import('../../server/src/services/run-estimate')
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { AI_PRICE_READ_TRIES } = await import('../../server/src/lib/constants')
const pauseByHand = (runId: string) => () =>
  db.prepare("UPDATE ai_runs SET status = 'paused' WHERE id = ?").run(runId)
const price = { prompt: 0.000001, completion: 0.000001, request: 0 }

const unread = runOf(3, 2, 1)
await ok("a model list that can't be read: tried again, then the run pauses before any call", async () => {
  stand.models = 'fail'
  stand.calls = 0
  await endsWithin(processAIRun(unread.runId, 0), 20_000, pauseByHand(unread.runId))
  const r = runRow(unread.runId)
  assert.equal(r.status, 'paused', r.error_message ?? '')
  assert.equal(r.pause_reason, 'provider_errors')
  assert.equal(r.error_message, PRICE_UNREAD_MESSAGE)
  assert.equal(stand.modelsHits, AI_PRICE_READ_TRIES)
  assert.equal(stand.calls, 0, 'no row ran without its price')
  assert.deepEqual(cells(unread.sid), [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER])
  assert.equal(holds(unread.runId), 0)
})

await ok('a read that works on a later try lets the run go on; a resume of the paused one retries', async () => {
  stand.models = 'ok'
  stand.modelsFailFirst = AI_PRICE_READ_TRIES - 1
  stand.modelsHits = 0
  const { sid, runId } = runOf(2, 2, 1)
  await endsWithin(processAIRun(runId, 0), 20_000, pauseByHand(runId))
  assert.equal(runRow(runId).status, 'completed')
  assert.equal(stand.modelsHits, AI_PRICE_READ_TRIES)
  assert.deepEqual(cells(sid), ['Hello', 'Hello'])
  assert.deepEqual(await resumeAiRun(unread.runId, uid, undefined, true), { ok: true })
  await endsWithin(processAIRun(unread.runId, runRow(unread.runId).worker_generation), 20_000,
    pauseByHand(unread.runId))
  assert.equal(runRow(unread.runId).status, 'completed')
  assert.equal(runRow(unread.runId).spend_limit_usd, 1)
})

await ok('a negative listed price is no price: the run stops on what was billed; the estimate has none', async () => {
  stand.calls = 0
  const { sid, runId } = runOf(6, 1, 0.012, VARIES)
  await endsWithin(processAIRun(runId, 0), 20_000, pauseByHand(runId))
  const r = runRow(runId)
  assert.equal(r.status, 'paused')
  assert.match(r.error_message ?? '', /No price is listed for its model, so it stopped on what was billed/)
  assert.ok(stand.calls >= 3 && stand.calls < 6, `calls ${stand.calls}`)
  assert.equal(cells(sid).filter(v => v === PLACEHOLDER).length, 6 - stand.calls)
  const est = await estimateAiRun(uid, { sheetId: sid, prompt: 'Say hi to /name', model: VARIES, maxChars: null,
    concurrency: 1 })
  assert.ok('ok' in est)
  assert.equal(est.ok.pricing_available, false)
  assert.equal(est.ok.estimated_cost_usd, null)
  assert.equal(est.ok.row_most_usd, null)
  // A negative request fee too: the model list keeps it, so it reads as no listed price.
  const fee = await estimateAiRun(uid, { sheetId: sid, prompt: 'Say hi to /name', model: FEE_VARIES, maxChars: null,
    concurrency: 1 })
  assert.ok('ok' in fee && fee.ok.pricing_available === false && fee.ok.estimated_cost_usd === null)
})

await ok("the estimate prices a variant as its model and names one row's most as the run holds it", async () => {
  const { sid, runId } = runOf(4, 1, 1)
  const gate = rowMaxMicro(price, rowFixedOf(runById(runId) as never), 'Say hi to N3'.length) / 1e6
  for (const model of [PRICED, `${PRICED}:nitro`, `${PRICED}@preset/fast`]) {
    const est = await estimateAiRun(uid, { sheetId: sid, prompt: 'Say hi to /name', model, maxChars: null,
      concurrency: 1 })
    assert.ok('ok' in est, model)
    assert.equal(est.ok.pricing_available, true, model)
    assert.ok(est.ok.estimated_cost_usd !== null, model)
    assert.equal(est.ok.row_most_usd, gate, model)
  }
})

await ok("a ceiling under the high end plus one row's most is refused; one covering both runs every row", async () => {
  const cost = stand.costUsd
  stand.costUsd = 0.000001
  const sid = sheetOf(4)
  const caller = { userId: uid, tokenId: 'tok-test', scopes: new Set(['read', 'write', 'run']) }
  const args = { sheet_id: sid, column_name: 'Hi', prompt: 'Say hi to /name', model: PRICED, concurrency: 1 }
  const est = await tokenStartAiRun(caller, { ...args, estimate_only: true })
  assert.ok('ok' in est)
  const e = est.ok as { estimated_cost_usd: { high: number }; row_most_usd: number }
  const high = e.estimated_cost_usd.high, most = e.row_most_usd
  assert.ok(most > high, `a row's most ${most}, the high end ${high}`)
  const short = Math.round((high + most / 2) * 1e6) / 1e6
  const view = await tokenStartAiRun(caller, { ...args, estimate_only: true, max_cost_usd: short })
  assert.ok('ok' in view)
  assert.equal((view.ok as { over_ceiling: boolean }).over_ceiling, true)
  const refused = await tokenStartAiRun(caller, { ...args, max_cost_usd: short })
  assert.ok('fail' in refused && refused.fail === 'over_ceiling', JSON.stringify(refused))
  const said = refused.message
  assert.match(said, /^It could cost up to \$\S+, and its spend limit starts a row only while the row's most /)
  assert.match(said, /room for one row at its most on top \(up to \$0\.008\): \$0\.0081 in all, more than/)
  assert.match(said, /ceiling \(max_cost_usd\)\. Raise max_cost_usd to at least \$0\.0081, or run fewer rows\./)
  assert.equal(db.prepare('SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ?').pluck().get(sid), 0)
  assert.equal(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(sid), '["name"]')
  const need = Math.ceil((high + most) * 1e6) / 1e6
  const fits = await tokenStartAiRun(caller, { ...args, estimate_only: true, max_cost_usd: need })
  assert.ok('ok' in fits)
  assert.equal((fits.ok as { over_ceiling: boolean }).over_ceiling, false)

  // Why: a run limited to `short` stops before its first row; one limited to `need` (as the start sets it) runs all.
  const stops = runOf(4, 1, short)
  await endsWithin(processAIRun(stops.runId, 0), 20_000, pauseByHand(stops.runId))
  assert.equal(runRow(stops.runId).pause_reason, 'spend_limit')
  assert.equal(cells(stops.sid).filter(v => v === PLACEHOLDER).length, 4)
  const all = runOf(4, 1, need)
  await endsWithin(processAIRun(all.runId, 0), 20_000, pauseByHand(all.runId))
  assert.equal(runRow(all.runId).status, 'completed')
  assert.deepEqual(cells(all.sid), ['Hello', 'Hello', 'Hello', 'Hello'])
  stand.costUsd = cost
})

await ok('a resume refused for another reason (its model is gone) keeps the old limit', async () => {
  const { runId } = runOf(2, 1, 0.01, 'test/unlisted')
  db.prepare("UPDATE ai_runs SET status = 'paused' WHERE id = ?").run(runId)
  const out = await resumeAiRun(runId, uid, 5, true)
  assert.ok('fail' in out && out.fail === 'model_gone', JSON.stringify(out))
  assert.equal(runRow(runId).spend_limit_usd, 0.01)
  assert.equal(runRow(runId).status, 'paused')
})

stand.close()
w.done()

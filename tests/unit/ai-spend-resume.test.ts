// An AI run's spend limit on resume, and what counts as spent (second review),
// against a stand-in for OpenRouter (ai-spend-kit.ts):
//   - the least limit a run paused at its limit can go on with is what it
//     spent, plus what its cut-off calls count, plus its next row's most
//     (services/ai-run-limit.ts, the app dialog's light read); a resume a
//     micro-dollar under it is refused and names it; one that rounds to it
//     goes on, and the worker rounds the limit the same way;
//   - a cut-off call's most stays counted across a resume
//     (ai_runs.spend_cut_off_micro): the new worker runs only the rows that fit;
//   - a setup's resume is refused while a step's AI run is paused at its
//     limit, and changes nothing; paused by hand, it resumes;
//   - a connection reset counts as maybe billed only when it came 2 s or more
//     after a try went out, also when the try after it reset at once; a reset
//     at once (the stale socket) is tried again and never counts;
//   - a negative listed price is no price for a waterfall's AI step and for a
//     preview's token cost (never $0).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { endsWithin, OUT, PRICED, sleep, startStandIn, VARIES, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const sdk = createRequire(import.meta.url)('openai') as typeof import('openai')

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, runOf, sheetOf, cells, runRow, runById, PLACEHOLDER } = w
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { rowFixedOf } = await import('../../server/src/services/ai-spend-gate')
const { rowMaxMicro } = await import('../../server/src/lib/ai-spend-limit')
const { aiLimitView, resumeAiRun } = await import('../../server/src/services/ai-run-limit')
const { processRow } = await import('../../server/src/services/ai-row')
const { priceAiStep } = await import('../../server/src/services/waterfall-ai-price')
const { previewCosts } = await import('../../server/src/services/run-preview-cost')
const { insertSetup } = await import('../../server/src/services/setup-library')
const { insertSetupRun, saveSteps, setStatus, getSetupRun } = await import('../../server/src/services/setup-run-store')
const { controlSetupRun } = await import('../../server/src/services/setup-run-control')
const { planApply } = await import('../../server/src/lib/setups/apply-plan')
const { sheetCandidates } = await import('../../server/src/services/setup-steps')
type Spec = import('../../server/src/lib/setups/spec').SetupSpec

// The most one of these rows can cost, in micro-dollars: "Say hi to N0" is 12 bytes.
const mostOf = (runId: string) =>
  rowMaxMicro({ prompt: 0.000001, completion: 0.000001, request: 0 }, rowFixedOf(runById(runId) as never), 12)
const pauseByHand = (runId: string) => () =>
  db.prepare("UPDATE ai_runs SET status = 'paused' WHERE id = ?").run(runId)
const kept = (runId: string) => db.prepare(`SELECT spend_cut_off_micro AS cut, spend_next_row_micro AS next
  FROM ai_runs WHERE id = ?`).get(runId) as { cut: number; next: number | null }

await ok("resume needs what it spent, plus cut-off calls, plus the next row's most; the cut-off stays counted",
  async () => {
    stand.calls = 0
    const cost = stand.costUsd
    stand.costUsd = 0.0001
    stand.answer = n => (n === 1 ? 'cut' : 'ok')
    const { sid, runId } = runOf(4, 1, 1)
    const most = mostOf(runId)
    // Room for one row at its most and half another: after the cut-off call the run pauses.
    db.prepare('UPDATE ai_runs SET spend_limit_usd = ? WHERE id = ?').run(most * 1.5 / 1e6, runId)
    await endsWithin(processAIRun(runId, 0), 15_000, pauseByHand(runId))
    stand.answer = () => 'ok'
    const r = runRow(runId)
    assert.equal(stand.calls, 1)
    assert.equal(r.pause_reason, 'spend_limit')
    assert.deepEqual(kept(runId), { cut: most, next: most }, "the cut-off call's most and the next row's are kept")

    // The dialog's read: the column, why, the least limit (exact) and enough to finish the rows left.
    const v = aiLimitView(runId, uid)!
    assert.equal(v.column_name, OUT)
    assert.equal(v.message, r.error_message)
    assert.deepEqual([v.spent_usd, v.cut_off_usd, v.next_row_usd], [0, most / 1e6, most / 1e6])
    assert.equal(Math.round(v.least_usd * 1e6), 2 * most)
    assert.equal(v.rows_left, 3)
    assert.equal(v.suggest_usd, Math.ceil((most + 3 * most) / 1e4 - 1e-9) / 100)

    // A micro-dollar under it is refused, naming it, and nothing changes.
    const under = await resumeAiRun(runId, uid, (2 * most - 1) / 1e6, true)
    assert.ok('fail' in under && under.fail === 'bad_request', JSON.stringify(under))
    assert.match(under.message, /^The run paused at its \$0\.0\d+ spend limit: it spent \$0\.00, calls cut off /)
    assert.match(under.message, /billed up to \$0\.00\d+ \(that counts as spent\) and its next row could cost up/)
    assert.match(under.message, /Resume it with a higher spend_limit_usd, at least \$0\.0\d+, to go on\.$/)
    assert.deepEqual(runRow(runId), r)

    // Rounded to the micro-dollar, as the worker rounds it: a hair under the least resumes, and a row starts.
    assert.deepEqual(await resumeAiRun(runId, uid, (2 * most - 0.4) / 1e6, true), { ok: true })
    await endsWithin(processAIRun(runId, runRow(runId).worker_generation), 15_000, pauseByHand(runId))
    // The cut-off call still counts after the resume: room for exactly one more row.
    assert.equal(stand.calls, 2, 'one more row ran')
    assert.equal(runRow(runId).pause_reason, 'spend_limit')
    assert.deepEqual(cells(sid).slice(1), ['Hello', PLACEHOLDER, PLACEHOLDER])
    stand.costUsd = cost
  })

await ok("a setup's resume is refused while a step's AI run is paused at its limit; paused by hand it resumes",
  async () => {
    const spec: Spec = { v: 1, inputs: ['name'], keys: [], steps: [{
      kind: 'ai', name: 'Hi', prompt: 'Say hi to /name', systemPrompt: null, model: PRICED, temperature: 0.7,
      maxChars: null, concurrency: null, webSearch: false, webFetch: false, search: null, outputColumns: null,
      runIf: null,
    }] }
    const setup = insertSetup(uid, 'Greet', null, spec)
    if (!('ok' in setup)) throw new Error(JSON.stringify(setup))
    const where = sheetOf(2)
    const plan = planApply(spec, ['name'], {}, sheetCandidates(where, uid))
    if (!('ok' in plan)) throw new Error(JSON.stringify(plan))
    const id = insertSetupRun({ userId: uid, sheetId: where, setupId: setup.ok.id, setupName: 'Greet',
      plan: { spec: plan.ok.spec, layers: plan.ok.layers, modes: plan.ok.modes }, targetRowIds: null,
      allowSecrets: true, autoRun: false })
    const { runId } = runOf(2, 1, 0.01)
    saveSteps(id, [{ state: 'running', kind: 'ai', runId }])
    setStatus(id, 'paused')
    db.prepare(`UPDATE ai_runs SET status = 'paused', pause_reason = 'spend_limit', error_message = 'At its limit.'
      WHERE id = ?`).run(runId)
    const before = runRow(runId)
    const out = await controlSetupRun(uid, id, 'resume', true)
    assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
    assert.equal(out.message, `"${OUT}" paused at its $0.01 spend limit, and resuming the setup can't raise it. `
      + 'Stop the setup and apply it again with a higher max_cost_usd: that carries on where this one stopped.')
    assert.equal(getSetupRun(uid, id)!.status, 'paused')
    assert.deepEqual(runRow(runId), before)
    db.prepare('UPDATE ai_runs SET pause_reason = NULL WHERE id = ?').run(runId)
    const again = await controlSetupRun(uid, id, 'resume', true)
    assert.ok('ok' in again, JSON.stringify(again))
    assert.equal(runRow(runId).status, 'pending')
    setStatus(id, 'cancelled')
    db.prepare("UPDATE ai_runs SET status = 'cancelled' WHERE id = ?").run(runId)
  })

await ok('a connection reset counts as maybe billed only when it came 2 s or more after a try went out', async () => {
  const { runId } = runOf(1, 1, 1)
  db.prepare("UPDATE ai_runs SET status = 'running' WHERE id = ?").run(runId)
  const run = runById(runId) as never
  const client = new sdk.OpenAI({
    apiKey: 'sk-or-test', baseURL: process.env.OPENROUTER_BASE_URL, maxRetries: 0, timeout: 30_000,
  })
  const outcomeOf = async (answer: typeof stand.answer) => {
    stand.calls = 0
    stand.answer = answer
    const o = await processRow(runId, { rowIndex: 0, data: { name: 'N0' } }, run, client, undefined, 0)
    stand.answer = () => 'ok'
    return o
  }
  const late = () => sleep(2_300).then(() => 'reset' as const)
  // At once (a stale keep-alive socket): tried once more, and never sent.
  const now = await outcomeOf(() => 'reset')
  assert.equal(stand.calls, 2, 'a reset at once is tried once more')
  assert.ok(now.kind === 'failed' && now.message.includes('ECONNRESET'), JSON.stringify(now))
  assert.equal(now.kind === 'failed' && !!now.maybeBilled, false)
  // Late: it may follow a billed answer.
  const slow = await outcomeOf(late)
  assert.equal(slow.kind === 'failed' && slow.maybeBilled, true, JSON.stringify(slow))
  // Late, then at once on the try after it: the late try may still be billed.
  const mixed = await outcomeOf(n => (n === 1 ? late() : 'reset'))
  assert.equal(stand.calls, 2)
  assert.equal(mixed.kind === 'failed' && mixed.maybeBilled, true, JSON.stringify(mixed))
})

await ok("a negative listed price is no price for a waterfall's AI step and a preview's token cost", async () => {
  const block = { resultType: 'text' } as never
  const sample = [{ name: 'N0' }]
  const varies = await priceAiStep(uid, block, VARIES, 'Say hi to /name', false, sample)
  assert.ok('ok' in varies && varies.ok.priced === false && varies.ok.capUsd === 0, JSON.stringify(varies))
  assert.match(varies.ok.note ?? '', /no fixed price for this model \(it varies\)/)
  const priced = await priceAiStep(uid, block, PRICED, 'Say hi to /name', false, sample)
  assert.ok('ok' in priced && priced.ok.priced === true && priced.ok.capUsd > 0, JSON.stringify(priced))
  // Token usage without a reported cost: priced from the list, or unknown when the price varies.
  const results = [{ rowIndex: 0, value: 'Hello', promptTokens: 0, completionTokens: 1000 }]
  const o = { maxChars: null, concurrency: 1, web: false }
  assert.equal((await previewCosts(uid, results, VARIES, 10, o)).fields.measured_cost_usd, null)
  assert.equal((await previewCosts(uid, results, PRICED, 10, o)).fields.measured_cost_usd, 0.001)
})

stand.close()
w.done()

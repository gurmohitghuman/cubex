// A workspace whose OpenRouter admin limited web fetch engines without Exa (lib/web-engine-refusal.ts), on a
// stand-in for OpenRouter (ai-spend-kit.ts): the matcher knows the refusal from OpenRouter's documented error shape
// and nothing else (moderation, guardrail, budget and key 403s, other statuses, runs without limits); a run with
// fetch limits that meets it pauses once (pause_reason web_engine, words naming Exa and the Server Tools page), fails
// no row and leaves every row waiting, single and multi-column alike; a resume once Exa is allowed runs every row
// once; a moderation 403 is still a row error, and so is the engine refusal on a run without limits.
import assert from 'node:assert/strict'
import { endsWithin, OUT, PRICED, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, sheetOf, runRow, PLACEHOLDER } = w
const { webEngineRefusalWords, webEngineRefusal } = await import('../../server/src/lib/web-engine-refusal')
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { resumeAiRun } = await import('../../server/src/services/ai-run-limit')
const { getAiRunSummary } = await import('../../server/src/services/run-status')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
const caller = { userId: uid, tokenId: 'tok-engine', scopes: new Set(['read', 'write', 'run']) }

// The refusal as an OpenRouter 403 body would carry it (the words are an assumption: none were seen live).
const ENGINE = { status: 403,
  message: 'Web fetch engine "exa" is not allowed by this workspace\'s server tools settings' }
const MODERATION = { status: 403,
  message: `${PRICED} requires moderation on OpenAI. Your input was flagged for "violence".`,
  metadata: { reasons: ['violence'], flagged_input: 'use the exa engine to web fetch it', provider_name: 'OpenAI',
    model_slug: PRICED } }
const sdkError = (status: number, error: object) => ({ status, error, message: `${status} ${JSON.stringify(error)}` })
const LIMITED = { web_fetch_max_content_tokens: 500, web_fetch_max_pages: 2, use_web_fetch: 1 }

await ok('the matcher: the engine refusal in its message or metadata, nothing else', () => {
  assert.match(webEngineRefusalWords(sdkError(403, { code: 403, message: ENGINE.message }))!, /engine "exa"/)
  assert.ok(webEngineRefusalWords(sdkError(403, { code: 403, message: 'Forbidden',
    metadata: { engine: 'exa', allowed_engines: ['native'] } })))
  const not = [
    sdkError(403, { code: 403, message: MODERATION.message, metadata: MODERATION.metadata }),
    // No message: the SDK's own message is then the whole body, the user's flagged words included.
    sdkError(403, { code: 403, metadata: MODERATION.metadata }),
    sdkError(403, { code: 403, message: 'Request blocked: prompt injection patterns detected',
      metadata: { patterns: ['web fetch engine exa'] } }),
    sdkError(403, { code: 403, message: 'Budget limit exceeded (weekly limit). Contact your org admin.',
      metadata: { limit_source: 'openrouter_guardrail_budget' } }),
    sdkError(403, { code: 403, message: 'Only management keys can perform this operation' }),
    sdkError(400, { code: 400, message: ENGINE.message }),
    { status: 403, message: '403 status code (no body)' },
    new Error(ENGINE.message), null,
  ]
  for (const e of not) assert.equal(webEngineRefusalWords(e), null, JSON.stringify(e))
  const refusal = sdkError(403, { code: 403, message: ENGINE.message })
  assert.equal(webEngineRefusal({ use_web_fetch: 1 }, refusal), null, 'no limits: no engine sent')
  assert.ok(webEngineRefusal(LIMITED, refusal))
})

async function started(rows: number, extra: Record<string, unknown>) {
  const sid = sheetOf(rows)
  const out = await tokenStartAiRun(caller, { sheet_id: sid, column_name: 'Hi', prompt: 'Read about /name',
    model: PRICED, web_fetch: true, concurrency: 2, ...extra })
  assert.ok('ok' in out && out.started, JSON.stringify(out))
  await idle(sid)
  return { sid, runId: (out.ok as { run_id: string }).run_id }
}
const cellsOf = (sid: string, column: string) => db.prepare(`SELECT json_extract(data, ?) FROM rows WHERE sheet_id = ?
  ORDER BY row_index`).pluck().all(`$."${column}"`, sid) as string[]
const results = (runId: string, status: string) => db.prepare(`SELECT COUNT(*) FROM ai_results WHERE run_id = ?
  AND status = ?`).pluck().get(runId, status) as number

const limits = { max_content_tokens: 500, max_pages_per_row: 2 }
let paused = { sid: '', runId: '' }
await ok('a run with limits pauses once on the refusal, fails no row and leaves every row waiting', async () => {
  paused = await started(5, limits)
  stand.calls = 0
  stand.answer = () => ENGINE
  await endsWithin(processAIRun(paused.runId, 0), 20_000, () => {})
  const r = runRow(paused.runId)
  assert.equal(r.status, 'paused')
  assert.equal(r.pause_reason, 'web_engine')
  assert.match(r.error_message!, /^OpenRouter refused the web fetch engine Exa \(403\)/)
  assert.match(r.error_message!, /Allow Exa there, then resume this run, or run the column again without the two/)
  assert.match(r.error_message!, /OpenRouter said: Web fetch engine "exa" is not allowed/)
  assert.ok(stand.calls <= 2, `only the rows out at the time were sent (${stand.calls})`)
  assert.equal(results(paused.runId, 'failed'), 0)
  assert.ok(cellsOf(paused.sid, OUT).every(v => v === PLACEHOLDER), JSON.stringify(cellsOf(paused.sid, OUT)))
  const summary = getAiRunSummary(paused.runId, uid) as unknown as Record<string, unknown>
  assert.equal(summary.pause_reason, 'web_engine')
  assert.equal(summary.pause_message, r.error_message)
})

await ok('a resume once Exa is allowed goes on and runs every row once', async () => {
  stand.calls = 0
  stand.answer = () => 'ok'
  assert.deepEqual(await resumeAiRun(paused.runId, uid, undefined, true), { ok: true })
  await endsWithin(processAIRun(paused.runId, runRow(paused.runId).worker_generation), 20_000, () => {})
  assert.equal(runRow(paused.runId).status, 'completed')
  assert.equal(stand.calls, 5)
  assert.ok(cellsOf(paused.sid, OUT).every(v => v === 'Hello'))
  assert.equal(results(paused.runId, 'completed'), 5)
  assert.equal(db.prepare('SELECT COUNT(DISTINCT row_index) FROM ai_results WHERE run_id = ?').pluck()
    .get(paused.runId), 5)
})

await ok('a multi-column run with limits pauses the same way', async () => {
  const multi = await started(3, { ...limits,
    output_columns: [{ column_name: 'Topic', type: 'string', description: 'What it is about' }] })
  stand.answer = () => ENGINE
  await endsWithin(processAIRun(multi.runId, 0), 20_000, () => {})
  assert.equal(runRow(multi.runId).pause_reason, 'web_engine')
  assert.equal(results(multi.runId, 'failed'), 0)
  assert.ok(cellsOf(multi.sid, 'Hi (Status)').every(v => v === PLACEHOLDER))
})

await ok('a moderation 403 is still a row error, and so is the refusal on a run without limits', async () => {
  for (const [answer, extra] of [[MODERATION, limits], [ENGINE, {}]] as const) {
    const run = await started(3, extra)
    stand.answer = () => answer
    await endsWithin(processAIRun(run.runId, 0), 20_000, () => {})
    const r = runRow(run.runId)
    assert.equal(r.pause_reason, null, JSON.stringify(r))
    assert.equal(results(run.runId, 'failed'), 3)
    assert.ok(cellsOf(run.sid, OUT).every(v => v.startsWith('❌')), JSON.stringify(cellsOf(run.sid, OUT)))
  }
})

stand.close()
w.done()
console.log('ai-web-engine-refusal: ok')
process.exit(0)

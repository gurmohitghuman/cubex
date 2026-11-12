// What estimate_only's history finds a prompt by (lib/ai-prompt-hash.ts, services/ai-token-history.ts), on a
// stand-in for OpenRouter (ai-spend-kit.ts): the column step needs the same prompt, so an edited prompt is sized
// from its own preview and not the old prompt's runs; the hash holds the system prompt and the output column count,
// as every start, rerun, setup version and preview stores it; a column rename rewrites the sheet's previews and
// their hash as it does runs' (system prompt and output count kept in it); a setup's estimate finds runs by the
// prompt its start stores, not the one it rewrites for pricing.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { endsWithin, PRICED, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, sheetOf } = w
const { promptHash } = await import('../../server/src/lib/ai-prompt-hash')
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { savePreviewTokens, previewTokenRows } = await import('../../server/src/services/ai-preview-history')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
const { rerunAiColumn } = await import('../../server/src/services/ai-run-rerun')
const { rerunAiMultiColumn } = await import('../../server/src/services/ai-run-rerun-multi')
const { writeAiSetup } = await import('../../server/src/services/setup-version-write')
const { startSetupStep } = await import('../../server/src/services/setup-step-start')
const { aiEstimate } = await import('../../server/src/services/setup-estimate')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
const hashOf = (id: string) => db.prepare('SELECT prompt_hash FROM ai_runs WHERE id = ?').pluck().get(id)
const caller = { userId: uid, tokenId: 'tok-prompt-key', scopes: new Set(['read', 'write', 'run']) }
const tokens = (n: number, out: number) => Array.from({ length: n }, () => ({ tokens: { input: 9, output: out,
  reasoning: null } }))
type Assumptions = { history_from: string | null; output_tokens: { low: number; high: number } }
async function historyOf(sheet: string, column: string, prompt: string, extra: Record<string, unknown> = {}) {
  const out = await tokenStartAiRun(caller, { sheet_id: sheet, column_name: column, prompt, model: PRICED,
    estimate_only: true, ...extra })
  assert.ok('ok' in out, JSON.stringify(out))
  const a = (out.ok as unknown as { assumptions: Assumptions }).assumptions
  return [a.history_from, a.output_tokens.low]
}
// A run started and run to the end on the stand-in, each row answering with `out` output tokens.
async function ranRun(started: unknown, sheet: string, out: number): Promise<string> {
  const s = started as { ok?: { run_id?: string; runId?: string } }
  assert.ok(s.ok, JSON.stringify(started))
  const runId = (s.ok.run_id ?? s.ok.runId)!
  await idle(sheet)
  stand.usage = () => ({ completion_tokens: out })
  await endsWithin(processAIRun(runId, 0), 20_000, () => {})
  stand.usage = () => ({})
  return runId
}

await ok("the column step needs this prompt: an edited one is sized from its preview, not the old prompt's runs",
  async () => {
    const S = sheetOf(3)
    const run = uuid()
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, prompt_hash)
      VALUES (?, ?, ?, 'Essay (Output)', ?, ?, 'completed', ?)`)
      .run(run, S, uid, 'Write an essay on /name', PRICED, promptHash('Write an essay on /name'))
    for (let i = 0; i < 6; i++) {
      db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, completion_tokens)
        VALUES (?, ?, ?, ?, 'x', 'completed', 900)`).run(uuid(), run, uid, i)
    }
    assert.deepEqual(await historyOf(S, 'Essay', 'Write an essay on /name'), ['column', 900])
    savePreviewTokens(uid, S, { model: PRICED, prompt: 'One word for /name', webSearch: false, webFetch: false,
      engineUsed: null }, tokens(6, 2))
    assert.deepEqual(await historyOf(S, 'Essay', 'One word for /name'), ['preview', 2])
  })

await ok('the system prompt and the output column count are part of what a start stores and an estimate finds',
  async () => {
    const A = sheetOf(6), B = sheetOf(3)
    const Q = 'Sum up /name in a line', sys = 'Answer in one line.'
    const runId = await ranRun(await tokenStartAiRun(caller, { sheet_id: A, column_name: 'Brief', prompt: Q,
      model: PRICED, system_prompt: sys }), A, 77)
    assert.equal(db.prepare('SELECT prompt_hash FROM ai_runs WHERE id = ?').pluck().get(runId), promptHash(Q, sys, 0))
    assert.deepEqual(await historyOf(B, 'Other', Q, { system_prompt: sys }), ['prompt', 77])
    assert.notEqual((await historyOf(B, 'Other', Q, { system_prompt: 'Write a long essay.' }))[0], 'prompt')
    assert.notEqual((await historyOf(B, 'Other', Q))[0], 'prompt')
    const typed = { system_prompt: sys, output_columns: [{ column_name: 'Gist', type: 'string', description: 'g' }] }
    assert.notEqual((await historyOf(B, 'Other', Q, typed))[0], 'prompt', 'one typed column: another key')
    const multi = await tokenStartAiRun(caller, { sheet_id: B, column_name: 'Two', prompt: Q, model: PRICED,
      output_columns: [{ column_name: 'X', type: 'string', description: 'x' },
        { column_name: 'Y', type: 'string', description: 'y' }] })
    assert.ok('ok' in multi, JSON.stringify(multi))
    await idle(B)
    const multiId = (multi.ok as { run_id: string }).run_id
    assert.equal(hashOf(multiId), promptHash(Q, null, 2))
    db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(multiId)
    const again = await rerunAiColumn(uid, { sheetId: A, baseColumnName: 'Brief', mode: 'all' })
    assert.ok('ok' in again, JSON.stringify(again))
    assert.equal(hashOf(again.ok.runId), promptHash(Q, sys, 0), 'a rerun stores it as its start did')
    const twice = await rerunAiMultiColumn(uid, { sheetId: B, baseColumnName: 'Two', mode: 'all' }, 'Two (Status)')
    assert.ok('ok' in twice, JSON.stringify(twice))
    assert.equal(hashOf(twice.ok.runId), promptHash(Q, null, 2), 'a multi-column rerun too')
    const saved = writeAiSetup(sheetOf(1), uid, 'Kept (Status)', { kind: 'ai', prompt: Q, systemPrompt: sys,
      model: PRICED, temperature: null, maxChars: null, concurrency: null, webSearch: false, webFetch: false,
      outputColumns: [{ columnName: 'G', type: 'string', description: 'g' }], dataColumn: null, searchEngine: null,
      searchMode: null, maxSearchesPerRow: null, searchEngineUsed: null, runIf: null })
    assert.equal(hashOf(saved), promptHash(Q, sys, 1), 'and a setup version written to a sheet')
    await Promise.all([idle(A), idle(B)])
  })

await ok('a preview stores its system prompt in its key, and only an estimate with it uses the preview', async () => {
  const V = sheetOf(5), P = 'Name a colour for /name', sys = 'One word only.'
  stand.usage = () => ({ completion_tokens: 33 })
  const prev = await tokenStartAiRun(caller, { sheet_id: V, column_name: 'Hue', prompt: P, model: PRICED,
    system_prompt: sys, preview_rows: 5 })
  stand.usage = () => ({})
  assert.ok('ok' in prev, JSON.stringify(prev))
  const kept = db.prepare('SELECT system_prompt, prompt_hash FROM ai_previews WHERE sheet_id = ?').get(V)
  assert.deepEqual({ ...kept as object }, { system_prompt: sys, prompt_hash: promptHash(P, sys, 0) })
  assert.deepEqual(await historyOf(V, 'Hue', P, { system_prompt: sys }), ['preview', 33])
  assert.notEqual((await historyOf(V, 'Hue', P))[0], 'preview')
})

await ok("a column rename rewrites the sheet's previews and their hash, system prompt kept", async () => {
  const R = sheetOf(2)
  savePreviewTokens(uid, R, { model: PRICED, prompt: 'Ping /name', systemPrompt: 'Be short.', webSearch: false,
    webFetch: false, engineUsed: null }, tokens(6, 4))
  const [sys, two] = [uuid(), uuid()]
  const run = db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, system_prompt, model,
    status, output_columns, prompt_hash) VALUES (?, ?, ?, ?, 'Ping /name', ?, ?, 'completed', ?, ?)`)
  run.run(sys, R, uid, 'Ping (Output)', 'Be short.', PRICED, null, promptHash('Ping /name', 'Be short.', 0))
  run.run(two, R, uid, 'Pair (Status)', null, PRICED, JSON.stringify([{ columnName: 'A' }, { columnName: 'B' }]),
    promptHash('Ping /name', null, 2))
  const renamed = await renameSheetColumn(R, uid, 'name', 'who')
  assert.ok(!('fail' in renamed), JSON.stringify(renamed))
  assert.equal(hashOf(sys), promptHash('Ping /who', 'Be short.', 0), "a run's system prompt stays in its hash")
  assert.equal(hashOf(two), promptHash('Ping /who', null, 2), "and its output column count")
  assert.equal(previewTokenRows(uid, PRICED, promptHash('Ping /who', 'Be short.', 0)).length, 6)
  assert.equal(previewTokenRows(uid, PRICED, promptHash('Ping /name', 'Be short.', 0)).length, 0)
  assert.deepEqual(await historyOf(R, 'Ping', 'Ping /who', { system_prompt: 'Be short.' }), ['preview', 4])
})

await ok("a setup's estimate finds runs by the prompt its start stores", async () => {
  const step = { kind: 'ai' as const, name: 'Greet', prompt: 'Greet /up warmly', systemPrompt: 'Be kind.',
    model: PRICED, temperature: 0.7, maxChars: null, concurrency: null, webSearch: false, webFetch: false,
    search: null, outputColumns: null, runIf: null }
  const A = sheetOf(6)
  db.prepare(`UPDATE sheets SET column_order = ? WHERE id = ?`).run(JSON.stringify(['name', 'Up']), A)
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Up', 'X') WHERE sheet_id = ?`).run(A)
  const started = await startSetupStep(uid, A, step, { rowIndexes: null, allowSecrets: false })
  assert.ok('ok' in started, JSON.stringify(started))
  await ranRun({ ok: { runId: (started.ok as { runId: string }).runId } }, A, 55)
  const est = await aiEstimate(uid, sheetOf(3), step, ['name'], ['Up'], null)
  assert.ok('ok' in est, JSON.stringify(est))
  assert.equal(est.ok.assumptions.history_from, 'prompt')
  assert.deepEqual(est.ok.assumptions.output_tokens, { low: 55, high: 55 })
})

stand.close()
w.done()
console.log('ai-run-costs-prompt-key: ok')
process.exit(0)

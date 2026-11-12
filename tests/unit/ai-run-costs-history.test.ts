// Where estimate_only's token history comes from (services/ai-token-history.ts, migration 055), on a stand-in for
// OpenRouter (ai-spend-kit.ts): this column's own runs first, then runs of the same prompt text on the model, then
// previews of that prompt, then any run on the model; a step needs AI_ESTIMATE_MIN_HISTORY rows or the next one
// answers; the answer names the step (assumptions.history_from). Also: a preview's rows feed it, a new preview of a
// prompt replaces the last on that sheet and each user keeps the newest AI_PREVIEW_HISTORY_MAX_ROWS rows, a column
// rename keeps a run's prompt hash in step with its rewritten prompt, the column step looks at the newest
// AI_ESTIMATE_HISTORY_SCAN_RUNS runs only, and every step is an index read (query plans).
// Over 200 lines: one history, seeded once and read step by step; split, each part would seed it again.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { PRICED, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, sheetOf } = w
const { promptHash } = await import('../../server/src/lib/ai-prompt-hash')
const { tokenHistory } = await import('../../server/src/services/ai-token-history')
const { columnRuns, promptRuns, modelRuns } = await import('../../server/src/services/ai-token-history-steps')
const { savePreviewTokens, previewTokenRows } = await import('../../server/src/services/ai-preview-history')
const { previewAiRun } = await import('../../server/src/services/run-preview')
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { renameAiRunColumnRefs } = await import('../../server/src/lib/ai-columns')
const { AI_ESTIMATE_MIN_HISTORY, AI_ESTIMATE_HISTORY_SCAN_RUNS, AI_PREVIEW_HISTORY_MAX_ROWS } =
  await import('../../server/src/lib/constants-ai')
const OTHER_MODEL = 'test/other'
const NO_WEB = { search: false, fetch: false }

// A finished run as a start stores it (prompt_hash unless `hash` is false), with `rows` completed rows of `out`
// output tokens and `input` input tokens; `at`: seconds after a fixed time, newest last.
let at = 0
function pastRun(o: { sheet: string; column: string; prompt: string; rows: number; out: number; input?: number;
  model?: string; hash?: boolean; fetch?: boolean }): string {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, prompt_hash,
    use_web_fetch, created_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, datetime('2026-01-01', ?))`)
    .run(id, o.sheet, uid, o.column, o.prompt, o.model ?? PRICED, o.hash === false ? null : promptHash(o.prompt),
      o.fetch ? 1 : 0, `+${++at} seconds`)
  for (let i = 0; i < o.rows; i++) {
    db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, prompt_tokens,
      completion_tokens) VALUES (?, ?, ?, ?, 'x', 'completed', ?, ?)`).run(uuid(), id, uid, i, o.input ?? 100, o.out)
  }
  return id
}
const tokens = (n: number, out: number) => Array.from({ length: n }, () => ({ tokens: { input: 9, output: out,
  reasoning: null } }))
const from = (sheetId: string, column: string | null, prompt: string, model = PRICED) => {
  const h = tokenHistory(uid, model, NO_WEB, null, { sheetId, column, prompt })
  return [h.output.from, h.output.range.low, h.output.historyRows]
}

const S = sheetOf(3)
const P = 'Sum up /name'
const elsewhere = sheetOf(1)
pastRun({ sheet: elsewhere, column: 'X (Output)', prompt: 'Other /name', rows: 6, out: 900 })
pastRun({ sheet: elsewhere, column: 'Y (Output)', prompt: P, rows: 6, out: 300 })
// Runs from before prompts were hashed: they count for their column whatever the prompt (and not for the prompt step).
pastRun({ sheet: S, column: 'Sum (Output)', prompt: 'Old words /name', rows: 6, out: 40, hash: false })
pastRun({ sheet: S, column: 'Thin (Output)', prompt: 'Thin /name', rows: AI_ESTIMATE_MIN_HISTORY - 1, out: 7,
  hash: false })
pastRun({ sheet: S, column: 'Moved (Output)', prompt: 'Moved /name', rows: 6, out: 8, model: OTHER_MODEL, hash: false })
savePreviewTokens(uid, S, { model: PRICED, prompt: 'Previewed /name', webSearch: false, webFetch: false,
  engineUsed: null }, tokens(6, 60))

await ok("this column's runs first, then the prompt's, then its previews, then the model's", () => {
  assert.deepEqual(from(S, 'Sum (Output)', P), ['column', 40, 6])
  assert.deepEqual(from(S, 'New (Output)', P), ['prompt', 300, 6])
  assert.deepEqual(from(S, 'New (Output)', 'Previewed /name'), ['preview', 60, 6])
  assert.equal(from(S, 'New (Output)', 'Never seen /name')[0], 'model')
  assert.equal(tokenHistory(uid, PRICED, NO_WEB).output.from, 'model', 'without a scope: the model, as before')
})

await ok('a step with fewer than the minimum rows, or another model, falls to the next', () => {
  assert.deepEqual(from(S, 'Thin (Output)', P), ['prompt', 300, 6])
  assert.deepEqual(from(S, 'Moved (Output)', P), ['prompt', 300, 6], "the column's runs on another model don't count")
  const none = tokenHistory(uid, 'test/unused', NO_WEB, null, { sheetId: S, column: 'Sum (Output)', prompt: P })
  assert.equal(none.output.from, null)
  assert.equal(none.output.basis, 'heuristic-no-history')
})

await ok('estimate_only names the step and its rows, for one column or output columns', async () => {
  const caller = { userId: uid, tokenId: 'tok-history', scopes: new Set(['read', 'run']) }
  const one = await tokenStartAiRun(caller, { sheet_id: S, column_name: 'Sum', prompt: P, model: PRICED,
    estimate_only: true })
  assert.ok('ok' in one, JSON.stringify(one))
  const a = (one.ok as any).assumptions
  assert.equal(a.history_from, 'column')
  assert.equal(a.history_rows, 6)
  assert.deepEqual(Object.keys(a).slice(-2), ['history_rows', 'history_from'])
  assert.match((one.ok as any).note, /from your past runs of this column\./)
  assert.equal((one.ok as any).basis, 'history', 'basis keeps its meaning')
  pastRun({ sheet: S, column: 'Sum (Status)', prompt: 'Typed /name', rows: 5, out: 12, hash: false })
  const typed = await tokenStartAiRun(caller, { sheet_id: S, column_name: 'Sum', prompt: P, model: PRICED,
    estimate_only: true, output_columns: [{ column_name: 'Total', type: 'number', description: 'A sum' }] })
  assert.ok('ok' in typed)
  assert.equal((typed.ok as any).assumptions.history_from, 'column')
  assert.deepEqual((typed.ok as any).assumptions.output_tokens, { low: 12, high: 12 })
})

await ok("a preview's rows feed the next estimate of its prompt", async () => {
  stand.calls = 0
  const sid = sheetOf(6)
  const prompt = 'Greet /name warmly'
  const prev = await previewAiRun(uid, { sheetId: sid, prompt, model: PRICED, maxChars: null, previewRows: 5,
    concurrency: 1 })
  assert.ok('ok' in prev, JSON.stringify(prev))
  assert.equal(stand.calls, 5)
  assert.deepEqual(from(sid, 'Greet (Output)', prompt), ['preview', 1, 5])
})

await ok('a new preview replaces the last one of that prompt on its sheet; failed rows are not kept', () => {
  const sid = sheetOf(1)
  const setup = { model: PRICED, prompt: 'Replace /name', webSearch: false, webFetch: false, engineUsed: null }
  savePreviewTokens(uid, sid, setup, tokens(6, 10))
  const failed = { error: 'bad', tokens: { input: 1, output: 999, reasoning: null } }
  savePreviewTokens(uid, sid, setup, [...tokens(5, 20), failed])
  const rows = previewTokenRows(uid, PRICED, promptHash('Replace /name'))
  assert.equal(rows.length, 5)
  assert.ok(rows.every(r => r.c === 20))
})

await ok('each user keeps only the newest preview rows', () => {
  const sid = sheetOf(1)
  const setup = { model: PRICED, prompt: 'Many /name', webSearch: false, webFetch: false, engineUsed: null }
  savePreviewTokens(uid, sid, setup, tokens(AI_PREVIEW_HISTORY_MAX_ROWS + 5, 33))
  const kept = db.prepare('SELECT COUNT(*) FROM ai_preview_tokens WHERE user_id = ?').pluck().get(uid) as number
  assert.equal(kept, AI_PREVIEW_HISTORY_MAX_ROWS)
  assert.equal(previewTokenRows(uid, PRICED, promptHash('Previewed /name')).length, 0, 'the oldest went first')
  assert.equal(db.prepare(`SELECT COUNT(*) FROM ai_previews v WHERE user_id = ?
    AND NOT EXISTS (SELECT 1 FROM ai_preview_tokens WHERE preview_id = v.id)`).pluck().get(uid), 0,
  'a preview left with no rows goes too')
})

await ok("a column rename keeps a run's prompt hash with its rewritten prompt", () => {
  const sid = sheetOf(1)
  const run = pastRun({ sheet: sid, column: 'Ask (Output)', prompt: 'Ask about /name', rows: 6, out: 70 })
  renameAiRunColumnRefs(sid, uid, 'name', 'person')
  const r = db.prepare('SELECT prompt, prompt_hash FROM ai_runs WHERE id = ?').get(run) as Record<string, string>
  assert.equal(r.prompt, 'Ask about /person')
  assert.equal(r.prompt_hash, promptHash('Ask about /person'))
  assert.deepEqual(from(S, 'New (Output)', 'Ask about /person'), ['prompt', 70, 6])
})

await ok('web input comes from runs with the same web tools, in the same order', () => {
  const sid = sheetOf(1)
  pastRun({ sheet: sid, column: 'Read (Output)', prompt: 'Read /name', rows: 6, out: 5, input: 4000, fetch: true })
  pastRun({ sheet: sid, column: 'Read (Output)', prompt: 'Read /name', rows: 6, out: 5, input: 50 })
  const h = tokenHistory(uid, PRICED, { search: false, fetch: true }, null,
    { sheetId: sid, column: 'Read (Output)', prompt: 'Read /name' })
  assert.deepEqual(h.webInput, { low: 4000, high: 4000 })
})

await ok(`the column step looks at the newest ${AI_ESTIMATE_HISTORY_SCAN_RUNS} runs of the column only`, () => {
  const sid = sheetOf(1)
  pastRun({ sheet: sid, column: 'Busy (Output)', prompt: 'Busy /name', rows: 6, out: 15, hash: false })
  // Newer runs that finished no row (stopped batches): the window is AI_ESTIMATE_HISTORY_SCAN_RUNS runs.
  for (let i = 0; i < AI_ESTIMATE_HISTORY_SCAN_RUNS - 1; i++) {
    pastRun({ sheet: sid, column: 'Busy (Output)', prompt: 'Busy /name', rows: 0, out: 0, hash: false })
  }
  assert.equal(from(sid, 'Busy (Output)', 'Busy /name')[0], 'column', 'the oldest is the window\'s last run')
  pastRun({ sheet: sid, column: 'Busy (Output)', prompt: 'Busy /name', rows: 0, out: 0, hash: false })
  assert.equal(from(sid, 'Busy (Output)', 'Busy /name')[0], 'model', 'one more newer run pushes it out')
})

await ok('every step reads through its own index, with no sort over all runs', () => {
  const plans: string[] = []
  const prepare = db.prepare.bind(db)
  ;(db as any).prepare = (sql: string) => {
    if (/FROM ai_runs|FROM ai_previews/.test(sql) && !sql.startsWith('EXPLAIN')) {
      const params = (sql.match(/\?/g) ?? []).length
      plans.push((prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(params).fill(null)) as Array<{ detail: string }>)
        .map(p => p.detail).join(' | '))
    }
    return prepare(sql)
  }
  try {
    columnRuns(uid, S, 'Sum (Output)', PRICED, promptHash(P))
    promptRuns(uid, PRICED, promptHash(P))
    modelRuns(uid, PRICED)
    previewTokenRows(uid, PRICED, promptHash(P))
  } finally { (db as any).prepare = prepare }
  assert.equal(plans.length, 4)
  assert.match(plans[0], /SEARCH ai_runs USING INDEX idx_ai_runs_column_history/)
  assert.match(plans[1], /SEARCH ai_runs USING INDEX idx_ai_runs_prompt_history/)
  assert.match(plans[2], /SEARCH ai_runs USING INDEX idx_ai_runs_model_history/)
  assert.match(plans[3], /SEARCH v USING (COVERING )?INDEX idx_ai_previews_prompt/)
  assert.match(plans[3], /SEARCH t USING INDEX idx_ai_preview_tokens_preview/)
  for (const p of plans) assert.doesNotMatch(p, /SCAN (ai_runs|ai_previews|ai_preview_tokens|v|t)\b/, p)
  // The inner newest-first read needs no sort; only the outer one sorts its few kept runs.
  assert.doesNotMatch(plans[2], /TEMP B-TREE/, plans[2])
  console.log(plans.join('\n'))
})

stand.close()
w.done()
console.log('ai-run-costs-history: ok')
process.exit(0)

// estimate_only's token history matches the web fetch limits (services/ai-token-history.ts, migration 055), on a
// stand-in for OpenRouter (ai-spend-kit.ts): runs, previews and the search history count only with the same
// max_content_tokens and max_pages_per_row (no limit is a value of its own), so a limited run isn't sized from
// unlimited pages and an unlimited run isn't sized from short ones, this column's own runs included; a preview keeps
// its limits; every web-matched step still reads through its index.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { PRICED, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, sheetOf } = w
const { promptHash } = await import('../../server/src/lib/ai-prompt-hash')
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { searchHistory } = await import('../../server/src/services/ai-token-history')
const { columnRuns, promptRuns, modelRuns } = await import('../../server/src/services/ai-token-history-steps')
const { previewTokenRows } = await import('../../server/src/services/ai-preview-history')
const caller = { userId: uid, tokenId: 'tok-history-limits', scopes: new Set(['read', 'write', 'run']) }
type Range = { low: number; high: number }

// A finished web fetch run of `prompt` elsewhere (or in `on`), as a start stores it, with 6 rows of `input` input
// tokens.
const elsewhere = sheetOf(1)
let at = 0
function pastRun(prompt: string, input: number, limits: [number, number] | null, search = false,
  on = { sheet: elsewhere, column: 'Old (Output)' }): string {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status, prompt_hash,
    use_web_fetch, web_fetch_max_content_tokens, web_fetch_max_pages, use_openrouter_web_search,
    web_search_engine_used, created_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 1, ?, ?, ?, ?,
    datetime('2026-01-01', ?))`).run(id, on.sheet, uid, on.column, prompt, PRICED, promptHash(prompt),
    limits?.[0] ?? null, limits?.[1] ?? null, search ? 1 : 0, search ? 'exa' : null, `+${++at} seconds`)
  for (let i = 0; i < 6; i++) {
    db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, prompt_tokens,
      completion_tokens, web_searches, cost_usd) VALUES (?, ?, ?, ?, 'x', 'completed', ?, 5, 2, 0.01)`)
      .run(uuid(), id, uid, i, input)
  }
  return id
}
const T = sheetOf(5)
const LIMITED = { max_content_tokens: 500, max_pages_per_row: 1 }
async function inputOf(prompt: string, extra: Record<string, unknown> = {}): Promise<Range> {
  const out = await tokenStartAiRun(caller, { sheet_id: T, column_name: 'Est', prompt, model: PRICED,
    web_fetch: true, estimate_only: true, ...extra })
  assert.ok('ok' in out, JSON.stringify(out))
  return (out.ok as unknown as { assumptions: { input_tokens: Range } }).assumptions.input_tokens
}

await ok('limits of 500 tokens and 1 page are not sized from an unlimited run of the same prompt', async () => {
  const P = 'Read up on /name'
  const none = await inputOf(P, LIMITED)
  pastRun(P, 18_000, null)
  assert.deepEqual(await inputOf(P, LIMITED), none, 'as with no history: the prompt and one page of 500 tokens')
  assert.ok(none.high < 1_000, JSON.stringify(none))
  assert.deepEqual(await inputOf(P), { low: 18_000, high: 18_000 }, 'an unlimited estimate is sized from it')
})

await ok('an unlimited run is not sized from limited runs of the same prompt', async () => {
  const P = 'Look into /name'
  const twoPages = { max_content_tokens: 500, max_pages_per_row: 2 }
  const [none, noneTwo] = [await inputOf(P), await inputOf(P, twoPages)]
  pastRun(P, 600, [500, 1])
  assert.deepEqual(await inputOf(P), none, 'as with no history: the usual pages')
  assert.ok(none.high > 10_000, JSON.stringify(none))
  assert.deepEqual(await inputOf(P, LIMITED), { low: 600, high: 600 }, 'the same limits are sized from it')
  assert.deepEqual(await inputOf(P, twoPages), noneTwo, 'another page limit: no history either')
})

await ok("this column's own limited run sizes only an estimate with the same limits", async () => {
  const P = 'Sum up /name', C = sheetOf(5)
  const input = async (extra: Record<string, unknown>) => {
    const out = await tokenStartAiRun(caller, { sheet_id: C, column_name: 'Col', prompt: P, model: PRICED,
      web_fetch: true, estimate_only: true, ...extra })
    assert.ok('ok' in out, JSON.stringify(out))
    return (out.ok as unknown as { assumptions: { input_tokens: Range } }).assumptions.input_tokens
  }
  const none = await input({})
  pastRun(P, 650, [500, 1], false, { sheet: C, column: 'Col (Output)' })
  assert.deepEqual(await input(LIMITED), { low: 650, high: 650 })
  assert.deepEqual(await input({}), none, 'without limits the column\'s limited run is not used')
})

await ok('a preview keeps its limits, and only an estimate with the same ones uses it', async () => {
  const P = 'Skim /name'
  const none = await inputOf(P)
  stand.usage = () => ({ prompt_tokens: 700 })
  const prev = await tokenStartAiRun(caller, { sheet_id: T, column_name: 'Skim', prompt: P, model: PRICED,
    web_fetch: true, preview_rows: 5, ...LIMITED })
  stand.usage = () => ({})
  assert.ok('ok' in prev, JSON.stringify(prev))
  const kept = db.prepare(`SELECT web_fetch_max_content_tokens AS t, web_fetch_max_pages AS p FROM ai_previews
    WHERE prompt_hash = ?`).get(promptHash(P))
  assert.deepEqual({ ...kept as object }, { t: 500, p: 1 })
  assert.deepEqual(await inputOf(P, LIMITED), { low: 700, high: 700 })
  assert.deepEqual(await inputOf(P), none, 'without limits the preview is not used')
})

await ok('the search history matches the fetch limits too', () => {
  pastRun('Find /name', 900, null, true)
  const setup = { used: 'exa', mode: null, maxPerRow: null, fetch: true }
  assert.deepEqual(searchHistory(uid, PRICED, setup).searches, { low: 2, high: 2 })
  assert.equal(searchHistory(uid, PRICED, { ...setup, fetchLimits: { maxContentTokens: 500, maxPagesPerRow: 1 } })
    .searches, null)
})

await ok('every web-matched step reads through its index', () => {
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
  const web = { search: false, fetch: true, engine: null, maxContentTokens: 500, maxPages: 1 }
  const hash = promptHash('Read up on /name')
  try {
    columnRuns(uid, T, 'Est (Output)', PRICED, hash, web)
    promptRuns(uid, PRICED, hash, web)
    modelRuns(uid, PRICED, web)
    previewTokenRows(uid, PRICED, hash, web)
    searchHistory(uid, PRICED, { used: 'exa', mode: null, maxPerRow: null, fetch: true,
      fetchLimits: { maxContentTokens: 500, maxPagesPerRow: 1 } })
  } finally { (db as any).prepare = prepare }
  assert.equal(plans.length, 5)
  assert.match(plans[0], /SEARCH ai_runs USING INDEX idx_ai_runs_column_history/)
  assert.match(plans[1], /SEARCH ai_runs USING INDEX idx_ai_runs_prompt_history/)
  assert.match(plans[2], /SEARCH ai_runs USING INDEX idx_ai_runs_model_history/)
  assert.match(plans[3], /SEARCH v USING (COVERING )?INDEX idx_ai_previews_prompt/)
  assert.match(plans[4], /SEARCH ai_runs USING INDEX/)
  for (const p of plans) assert.doesNotMatch(p, /SCAN (ai_runs|ai_previews|ai_preview_tokens|v|t)\b/, p)
})

stand.close()
w.done()
console.log('ai-run-costs-history-limits: ok')
process.exit(0)

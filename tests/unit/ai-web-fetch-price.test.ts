// What web fetch adds to an AI estimate and to the money checks that read it (lib/ai-web-cost.ts,
// services/run-start-ceiling.ts, lib/ai-spend-limit.ts), on a stand-in for OpenRouter (ai-spend-kit.ts) whose
// web fetch entry says test/priced fetches pages itself: a model's own fetch counts $0 to $0.001 a page, so a
// max_cost_usd that only covers the tokens is refused and the ceiling reads the estimate's high end; with limits the
// pages go through Exa at $0.001 a page at both ends and nothing is unpriced; the per-row worst case follows limits
// that allow more than 3 pages of 6,000 tokens (never fewer); the column menu prices a rerun with the column's
// limits and its own history first, as run_ai_column does, and it and a setup's estimate (a step carried on
// included) say when the fetch fee is the provider's own price.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { endsWithin, PRICED, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, sheetOf, runRow } = w
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { aiCeilingFigures } = await import('../../server/src/services/run-start-ceiling')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { estimateRunControl } = await import('../../server/src/services/run-controls-estimate')
const { webPart } = await import('../../server/src/lib/ai-spend-limit')
const { insertSetup } = await import('../../server/src/services/setup-library')
const { applySetup } = await import('../../server/src/services/setup-apply')
const { applyInputOf } = await import('../../server/src/services/setup-apply-input')
const { estimateAgain } = await import('../../server/src/services/setup-estimate-again')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
const caller = { userId: uid, tokenId: 'tok-fetch-price', scopes: new Set(['read', 'write', 'run']) }
stand.gets['/tools/openrouter:web_fetch'] = { data: { native_support: { models: [{ slug: PRICED }] } } }
type Range = { low: number; high: number }
type Est = { estimated_cost_usd: Range; web_fees_usd: Range; row_most_usd: number; note: string }

const sid = sheetOf(3)
const base = { sheet_id: sid, column_name: 'Fit', prompt: 'Read about /name', model: PRICED, web_fetch: true }
const estimate = async (extra: Record<string, unknown> = {}) => {
  const out = await tokenStartAiRun(caller, { ...base, estimate_only: true, ...extra })
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok as unknown as Est
}

await ok("a model's own fetch counts $0 to $0.001 a page, and the ceiling reads that high end", async () => {
  const e = await estimate()
  assert.deepEqual(e.web_fees_usd, { low: 0, high: 0.009 }, 'up to 3 pages on each of 3 rows')
  assert.match(e.note, /provider reads pages itself, .* counted from \$0 to \$0\.001 a page/)
  const figures = aiCeilingFigures(e as never)
  assert.equal(figures.highUsd, e.estimated_cost_usd.high)
  assert.deepEqual(figures.unpriced, [])
})

await ok('a max_cost_usd that covers only the tokens is refused', async () => {
  const e = await estimate()
  const tokensOnly = e.estimated_cost_usd.high - e.web_fees_usd.high
  const max = Math.round((tokensOnly + e.row_most_usd + 0.004) * 1e6) / 1e6
  const out = await tokenStartAiRun(caller, { ...base, max_cost_usd: max })
  assert.ok('fail' in out && out.fail === 'over_ceiling', JSON.stringify(out))
  const shown = (out as { estimate: Est }).estimate
  assert.equal(shown.estimated_cost_usd.high, e.estimated_cost_usd.high, 'the figure checked is the estimate\'s')
  assert.equal(db.prepare('SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ?').pluck().get(sid), 0)
})

await ok('with limits the pages are $0.001 at both ends and nothing is unpriced', async () => {
  const e = await estimate({ max_content_tokens: 500, max_pages_per_row: 2 })
  assert.deepEqual(e.web_fees_usd, { low: 0.003, high: 0.006 }, '1 to 2 pages at $0.001 on each of 3 rows')
  assert.deepEqual(aiCeilingFigures(e as never).unpriced, [])
  assert.match(e.note, /read through Exa, at \$0\.001 a page/)
})

await ok('the worst case for a row follows limits that allow more pages or tokens, never fewer', async () => {
  const at = (fetchLimits: { maxContentTokens: number | null; maxPagesPerRow: number | null } | null) =>
    webPart({ model: PRICED, search: false, fetch: true, used: null, mode: null, maxPerRow: null, fetchLimits })
  assert.deepEqual(at({ maxContentTokens: 500, maxPagesPerRow: 1 }), at(null))
  assert.equal(at({ maxContentTokens: 100_000, maxPagesPerRow: 50 }).tokens - at(null).tokens, 50 * 100_000 - 18_000)
  assert.ok(Math.abs(at({ maxContentTokens: null, maxPagesPerRow: 10 }).feesUsd - 0.01) < 1e-12)
  const big = { max_content_tokens: 100_000, max_pages_per_row: 50 }
  assert.ok((await estimate(big)).row_most_usd > 5, '5 million tokens at $1 a million')
  const bigSheet = sheetOf(2)
  const run = await tokenStartAiRun(caller, { ...base, sheet_id: bigSheet, ...big, spend_limit_usd: 1 })
  assert.ok('ok' in run && run.started, JSON.stringify(run))
  const runId = (run.ok as { run_id: string }).run_id
  await idle(bigSheet)
  stand.calls = 0
  await endsWithin(processAIRun(runId, 0), 20_000, () => {})
  assert.equal(runRow(runId).pause_reason, 'spend_limit')
  assert.equal(stand.calls, 0, 'no row it could not afford was started')
})

// A run's rows finished, each with `out` output tokens.
function finished(runId: string, rows: number, out: number) {
  db.prepare('DELETE FROM ai_results WHERE run_id = ?').run(runId)
  db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(runId)
  for (let i = 0; i < rows; i++) {
    db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, prompt_tokens,
      completion_tokens) VALUES (?, ?, ?, ?, 'x', 'completed', 900, ?)`).run(uuid(), runId, uid, i, out)
  }
}

await ok("the column menu prices a rerun with the column's limits and history, as run_ai_column does", async () => {
  const menuSheet = sheetOf(6)
  const limited = { sheet_id: menuSheet, column_name: 'Menu', prompt: 'Read about /name', model: PRICED,
    web_fetch: true, max_content_tokens: 500, max_pages_per_row: 2 }
  const run = await tokenStartAiRun(caller, limited)
  assert.ok('ok' in run && run.started, JSON.stringify(run))
  await idle(menuSheet)
  finished((run.ok as { run_id: string }).run_id, 6, 40)
  const elseSheet = sheetOf(6)
  const other = await tokenStartAiRun(caller, { ...limited, sheet_id: elseSheet, column_name: 'Else' })
  assert.ok('ok' in other && other.started, JSON.stringify(other))
  await idle(elseSheet)
  finished((other.ok as { run_id: string }).run_id, 6, 4_000)
  const menu = await estimateRunControl(uid, menuSheet, { kind: 'ai', main: 'Menu (Output)' }, { rows: 'all' }, null)
  assert.ok('ok' in menu, JSON.stringify(menu))
  const est = await tokenStartAiRun(caller, { ...limited, estimate_only: true })
  assert.ok('ok' in est)
  const cost = (est.ok as unknown as Est).estimated_cost_usd
  assert.deepEqual([menu.ok.lowUsd, menu.ok.highUsd], [cost.low, cost.high])
  assert.equal(menu.ok.note, null, 'Exa\'s price is known')
})

await ok("the column menu and a setup's estimate say when the fetch fee is the provider's own price", async () => {
  const s2 = sheetOf(2)
  const run = await tokenStartAiRun(caller, { ...base, sheet_id: s2, column_name: 'Own' })
  assert.ok('ok' in run && run.started)
  await idle(s2)
  db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run((run.ok as { run_id: string }).run_id)
  const menu = await estimateRunControl(uid, s2, { kind: 'ai', main: 'Own (Output)' }, { rows: 'all' }, null)
  assert.ok('ok' in menu && menu.ok.highUsd !== null)
  assert.match(menu.ok.note ?? '', /provider reads web pages itself, at a price it sets: counted here at \$0 to/)
  const read = { kind: 'ai' as const, name: 'Read', prompt: 'Read about /name', systemPrompt: null, model: PRICED,
    temperature: 0.7, maxChars: null, concurrency: null, webSearch: false, webFetch: true, search: null,
    outputColumns: null, runIf: null }
  const setup = insertSetup(uid, 'Fetching', null, { v: 1, inputs: ['name'], keys: [], steps: [read] } as never)
  assert.ok('ok' in setup, JSON.stringify(setup))
  const input = applyInputOf({ estimate_only: true }, 'v1')
  assert.ok(!('fail' in input))
  const out = await applySetup(uid, sheetOf(2), setup.ok.id, input as never, { hasSecretsScope: true })
  assert.ok('ok' in out && 'estimate' in out.ok, JSON.stringify(out))
  const step = (out.ok as { estimate: { steps: Array<{ note: string | null; high_usd: number | null }> } })
    .estimate.steps[0]
  assert.ok(step.high_usd !== null)
  assert.match(step.note ?? '', /provider reads web pages itself/)
  const here = sheetOf(2)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['name', 'Read']), here)
  const again = await estimateAgain(uid, here, read, {} as never, { sheetColumns: ['name', 'Read'], made: [],
    rowIndexes: null })
  assert.equal(again.rows, 2)
  assert.match(again.note ?? '', /provider reads web pages itself/, 'carrying the column on says so too')
})

stand.close()
w.done()
console.log('ai-web-fetch-price: ok')
process.exit(0)

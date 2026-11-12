// Web fetch limits on an AI run (lib/web-fetch-options.ts, migration 055), on a stand-in for OpenRouter
// (ai-spend-kit.ts): max_content_tokens and max_pages_per_row are checked the same way for every surface (digits
// as text too) and refused out of range or without web_fetch; a run stores them, its rows send them as the web
// fetch tool's max_content_tokens and max_uses through Exa (a model's own fetch doesn't cut pages), and its
// tool-call budget makes room for exactly that many pages; a rerun and a saved setup keep them; the app's draft
// hashes them only when set; the estimate sizes pages and tokens by them, and counts the fetch fee from $0 to $0.001
// a page when the model's provider fetches on its own (its price is the provider's), Exa's $0.001 a page otherwise.
import assert from 'node:assert/strict'
import { endsWithin, PRICED, startStandIn, world } from './ai-spend-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const w = await world()
const { db, uid, ok, sheetOf } = w
const { parseFetchLimits } = await import('../../server/src/lib/web-fetch-options')
const { buildWebTools, toolCallBudget } = await import('../../server/src/lib/ai-web-tools')
const { fetchWork } = await import('../../server/src/lib/ai-web-cost')
const { parseFetchCatalog } = await import('../../server/src/services/web-fetch-catalog')
const { computeConfigHash } = await import('../../server/src/lib/ai-drafts')
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { processAIRun } = await import('../../server/src/services/ai-runner')
const { rerunAiColumn } = await import('../../server/src/services/ai-run-rerun')
const { sheetCandidates } = await import('../../server/src/services/setup-steps')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
const caller = { userId: uid, tokenId: 'tok-fetch', scopes: new Set(['read', 'write', 'run']) }
const limitsOf = (runId: string) => db.prepare(`SELECT web_fetch_max_content_tokens AS t, web_fetch_max_pages AS p
  FROM ai_runs WHERE id = ?`).get(runId) as { t: number | null; p: number | null }

await ok('the limits are whole numbers in range, digits as text too, and need web_fetch', () => {
  assert.deepEqual(parseFetchLimits({ maxContentTokens: 2000, maxPagesPerRow: '3' }, true),
    { ok: { maxContentTokens: 2000, maxPagesPerRow: 3 } })
  assert.deepEqual(parseFetchLimits({ maxContentTokens: '', maxPagesPerRow: null }, true),
    { ok: { maxContentTokens: null, maxPagesPerRow: null } })
  assert.deepEqual(parseFetchLimits({ maxContentTokens: 99 }, true),
    { error: 'max_content_tokens must be a whole number from 100 to 100,000.' })
  assert.deepEqual(parseFetchLimits({ maxContentTokens: 1500.5 }, true),
    { error: 'max_content_tokens must be a whole number from 100 to 100,000.' })
  assert.deepEqual(parseFetchLimits({ maxPagesPerRow: 51 }, true),
    { error: 'max_pages_per_row must be a whole number from 1 to 50.' })
  assert.deepEqual(parseFetchLimits({ maxContentTokens: 'lots', maxPagesPerRow: 0 }, true), {
    error: 'max_content_tokens must be a whole number from 100 to 100,000. '
      + 'max_pages_per_row must be a whole number from 1 to 50.',
  }, 'both wrong: both named at once')
  assert.deepEqual(parseFetchLimits({ maxPagesPerRow: 2 }, false),
    { error: 'max_content_tokens and max_pages_per_row need web_fetch turned on.' })
})

await ok('the web fetch tool gets the limits through Exa; without them it is sent exactly as before', () => {
  const plain = buildWebTools('Read /site', { site: 'acme.example' }, { search: null, fetch: true })
  assert.deepEqual(plain, [{ type: 'openrouter:web_fetch', parameters: { allowed_domains: ['acme.example'] } }])
  const limited = buildWebTools('Read /site', { site: 'acme.example' }, { search: null, fetch: true,
    fetchLimits: { maxContentTokens: 2000, maxPagesPerRow: null } })
  assert.deepEqual(limited, [{ type: 'openrouter:web_fetch', parameters: { allowed_domains: ['acme.example'],
    engine: 'exa', max_content_tokens: 2000 } }])
  const search = { engine: 'exa' as const, used: 'exa' as const, mode: null, maxPerRow: 2 }
  assert.equal(toolCallBudget(search, true), 9, 'cap 2 + slack 2 + 5 pages, as before')
  assert.equal(toolCallBudget(search, true, { maxContentTokens: null, maxPagesPerRow: 7 }), 11)
})

await ok("the estimate's fetch work: pages and tokens capped, $0 to $0.001 a page on a model's own fetch", () => {
  assert.deepEqual(fetchWork({ maxContentTokens: 1500, maxPagesPerRow: 2 }, true), {
    fetchPages: { low: 1, high: 2 }, fetchTokensPerPage: { low: 1000, high: 1500 },
    fetchPricePerPage: { low: 0.001, high: 0.001 },
  })
  assert.deepEqual(fetchWork(null, true).fetchPricePerPage, { low: 0, high: 0.001 })
  assert.deepEqual(fetchWork(null, false).fetchPricePerPage, { low: 0.001, high: 0.001 })
  assert.deepEqual([...parseFetchCatalog({ data: { native_support: { models: [{ slug: 'Test/Priced' }] } } })!],
    ['test/priced'])
  assert.equal(parseFetchCatalog({ data: { native_support: { models: [] } } }), null, 'none listed: unknown')
})

let runId = ''
const sid = sheetOf(2)
await ok('a run stores the limits and its rows send them; a start with bad ones is refused first', async () => {
  const base = { sheet_id: sid, column_name: 'Read', prompt: 'Read about /name', model: PRICED, web_fetch: true }
  assert.deepEqual(await tokenStartAiRun(caller, { ...base, max_pages_per_row: 0 }),
    { fail: 'bad_request', message: 'max_pages_per_row must be a whole number from 1 to 50.' })
  assert.deepEqual(await tokenStartAiRun(caller, { ...base, web_fetch: false, max_content_tokens: 500 }),
    { fail: 'bad_request', message: 'max_content_tokens and max_pages_per_row need web_fetch turned on.' })
  const started = await tokenStartAiRun(caller, { ...base, max_content_tokens: '2500', max_pages_per_row: 2 })
  assert.ok('ok' in started && started.started, JSON.stringify(started))
  runId = (started.ok as { run_id: string }).run_id
  await idle(sid)
  assert.deepEqual(limitsOf(runId), { t: 2500, p: 2 })
  stand.bodies.length = 0
  await endsWithin(processAIRun(runId, 0), 20_000, () => {})
  assert.equal(stand.bodies.length, 2)
  for (const b of stand.bodies) {
    assert.deepEqual(b.tools, [{ type: 'openrouter:web_fetch', parameters: { allowed_domains: [], engine: 'exa',
      max_content_tokens: 2500, max_uses: 2 } }])
  }
})

await ok('a rerun and a saved setup keep the limits', async () => {
  const again = await rerunAiColumn(uid, { sheetId: sid, baseColumnName: 'Read', mode: 'all' })
  assert.ok('ok' in again, JSON.stringify(again))
  await idle(sid)
  assert.deepEqual(limitsOf(again.ok.runId), { t: 2500, p: 2 })
  const step = sheetCandidates(sid, uid).find(c => c.kind === 'ai')!.step as { fetchLimits?: unknown }
  assert.deepEqual(step.fetchLimits, { maxContentTokens: 2500, maxPagesPerRow: 2 })
  db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(again.ok.runId)
})

await ok("the app's draft hashes the limits only when set", () => {
  const config = { columnName: 'Read', prompt: 'p', systemPrompt: null, model: PRICED, temperature: 0.2,
    useOpenRouterWebSearch: false, useWebFetch: true, maxChars: null, concurrency: 5 }
  assert.equal(computeConfigHash({ ...config, maxContentTokens: null, maxPagesPerRow: null }),
    computeConfigHash(config), 'no limits: the same hash as a draft saved before them')
  assert.notEqual(computeConfigHash({ ...config, maxPagesPerRow: 2 }), computeConfigHash(config))
})

await ok("the estimate counts $0 to $0.001 a page on a model's own fetch, and prices Exa with a limit", async () => {
  stand.gets['/tools/openrouter:web_fetch'] = { data: { native_support: { models: [{ slug: PRICED }] } } }
  const base = { sheet_id: sid, column_name: 'Est', prompt: 'Read about /name', model: PRICED, web_fetch: true,
    estimate_only: true }
  const own = await tokenStartAiRun(caller, base)
  assert.ok('ok' in own)
  const e = own.ok as { web_fees_usd: { low: number; high: number }; note: string }
  assert.deepEqual(e.web_fees_usd, { low: 0, high: 0.006 }, 'up to 3 pages at up to $0.001 on each of 2 rows')
  assert.match(e.note, /provider reads pages itself, at a price it sets and OpenRouter passes on/)
  const capped = await tokenStartAiRun(caller, { ...base, max_pages_per_row: 1, max_content_tokens: 500 })
  assert.ok('ok' in capped)
  const c = capped.ok as { web_fees_usd: { low: number; high: number }; note: string;
    assumptions: { input_tokens: { low: number; high: number } } }
  assert.deepEqual(c.web_fees_usd, { low: 0.002, high: 0.002 }, '1 page at $0.001 on each of 2 rows')
  assert.match(c.note, /read through Exa, at \$0\.001 a page/)
  assert.ok(c.assumptions.input_tokens.high - c.assumptions.input_tokens.low === 0, 'one page of at most 500 tokens')
})

stand.close()
w.done()
console.log('ai-web-fetch-limits: ok')
process.exit(0)

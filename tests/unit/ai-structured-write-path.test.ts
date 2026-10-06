// End-to-end structured-output write test WITHOUT a live model.
//
// The gap this fills: the live round-trip specs (mcp-multi-output*, 
// mcp-preview-idempotency) skip unless CUBEX_SMOKE_OPENROUTER_KEY is set, so the
// automated suite never ran a model response through the real writer. That is
// exactly the path that was corrupting prod. Here we feed REALISTIC completion
// objects (the shape the OpenRouter SDK returns) through the real
// extractCompletionText -> parseMultiOutput -> writeMultiSuccess chain and
// assert on the actual DB cells.
//
// Verified to be a real regression test: with the pre-fix behavior (markdown-
// cleaning the JSON) the first case below fails with "Model did not return
// valid JSON" instead of writing values.
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import ctMod from '../../server/src/lib/completion-text'
import moMod from '../../server/src/lib/ai-multi-output'
import wMod from '../../server/src/services/ai-row-writers-multi'
import rowMod from '../../server/src/services/ai-row-multi'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
runMigrations()
const { extractCompletionText } = ctMod as typeof import('../../server/src/lib/completion-text')
const { parseMultiOutput } = moMod as typeof import('../../server/src/lib/ai-multi-output')
const { writeMultiSuccess, writeMultiFailure } =
  wMod as typeof import('../../server/src/services/ai-row-writers-multi')
const { processMultiRow } = rowMod as typeof import('../../server/src/services/ai-row-multi')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const specs = [
  { columnName: 'Score', type: 'number' as const, description: '1-10' },
  { columnName: 'Reason', type: 'string' as const, description: 'why' },
]
const STATUS = 'Lead (Status)'

// One user/table reused; a fresh sheet + run per case.
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')

function freshRun(): { sid: string; rid: string } {
  const sid = uuid(), rid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['val', 'Score', 'Reason', STATUS]))
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,0,?)')
    .run(uuid(), sid, uid, JSON.stringify({ val: 'Stripe', Score: '', Reason: '', [STATUS]: '⏳ Processing...' }))
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,worker_generation,total_rows,processed_rows,output_columns,status_column)
    VALUES (?,?,?,?,?,?, 'running', 0, 1, 0, ?, ?)`)
    .run(rid, sid, uid, STATUS, 'Score /val', 'm', JSON.stringify(specs), STATUS)
  return { sid, rid }
}

// Run one realistic completion through the REAL chain, return the resulting cells.
function runThroughWriter(content: string): Record<string, string> {
  const { sid, rid } = freshRun()
  const completion = { choices: [{ message: { content }, finish_reason: 'stop' }] }
  const ctx = {
    runId: rid, userId: uid, sheetId: sid, rowIndex: 0,
    inputValues: JSON.stringify({ val: 'Stripe' }), statusColumn: STATUS, myGeneration: 0,
  }
  let rawText: string
  try { rawText = extractCompletionText(completion, { cleanMarkdown: false }) }
  catch (e: any) { writeMultiFailure(ctx, specs.map(s => s.columnName), e.message); return cells(sid) }
  const parsed = parseMultiOutput(rawText, specs)
  if ('error' in parsed) writeMultiFailure(ctx, specs.map(s => s.columnName), parsed.error)
  else writeMultiSuccess(ctx, parsed.ok, rawText)
  return cells(sid)
}
function cells(sid: string): Record<string, string> {
  return JSON.parse((db.prepare('SELECT data FROM rows WHERE sheet_id=? AND row_index=0').get(sid) as any).data)
}

// --- the shape that was breaking prod: fenced JSON --------------------------
const fenced = runThroughWriter('```json\n{"Score": 9, "Reason": "Top-tier #1 payments API, sells *developer-first* infra"}\n```')
check('fenced JSON writes the score', fenced.Score === '9')
check('fenced JSON preserves # in the value', fenced.Reason.includes('#1'))
check('fenced JSON preserves * in the value', fenced.Reason.includes('*developer-first*'))
check('fenced JSON marks the row ✅', fenced[STATUS] === '✅')
check('fenced JSON leaves no ⏳', !JSON.stringify(fenced).includes('⏳'))

// --- other shapes real models emit ------------------------------------------
const bare = runThroughWriter('```\n{"Score": 7, "Reason": "solid"}\n```')
check('bare ``` fence writes values', bare.Score === '7' && bare[STATUS] === '✅')

const plain = runThroughWriter('{"Score": 5, "Reason": "ok"}')
check('unfenced JSON still works', plain.Score === '5' && plain[STATUS] === '✅')

const backticks = runThroughWriter('{"Score": 4, "Reason": "run `npm i` first"}')
check('backticks inside a value survive', backticks.Reason === 'run `npm i` first')

// --- genuine failures must STILL fail, not write garbage --------------------
const prose = runThroughWriter('I think the score is about 8, honestly.')
check('non-JSON marks the row ❌', prose[STATUS].startsWith('❌'))
check('non-JSON blanks the output columns', prose.Score === '' && prose.Reason === '')
check('non-JSON leaves no ⏳', !JSON.stringify(prose).includes('⏳'))

// A missing key is a blank cell, not a row failure (deliberate design).
const partial = runThroughWriter('```json\n{"Score": 6}\n```')
check('missing key → blank cell, row still ✅', partial.Score === '6' && partial.Reason === '' && partial[STATUS] === '✅')

// --- web tools: ONE call fills the typed columns and the "(Data)" sources ------
// Drives the real runner (processMultiRow) with a fake OpenRouter client, so the
// tools it sends and the cells it writes are both the real thing.
const DATA = 'Lead (Data)'
// A search row goes through the Responses API (services/ai-model-call.ts); a
// fetch-only row through Chat Completions. The fake serves both: `searches` are
// the search calls the model made, `cost` OpenRouter's usage.cost.
type Search = { query: string; sources?: string[] }
async function webRow(
  web: { search: boolean; fetch: boolean }, content: string, annotations: any[] = [],
  opts: { searches?: Search[]; cost?: number; engine?: string; used?: string; mode?: string; cap?: number; refuseTemperature?: boolean; failed?: string } = {},
) {
  const sid = uuid(), rid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['domain', 'Score', 'Reason', STATUS, DATA]))
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,0,?)')
    .run(uuid(), sid, uid, JSON.stringify({ domain: 'stripe.com', Score: '', Reason: '', [STATUS]: '⏳ Processing...', [DATA]: '⏳ Processing...' }))
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,worker_generation,total_rows,processed_rows,
      output_columns,status_column,data_column,use_openrouter_web_search,use_web_fetch,
      web_search_engine,web_search_engine_used,web_search_mode,web_search_max_per_row)
    VALUES (?,?,?,?,?,?, 'running', 0, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(rid, sid, uid, STATUS, 'Score /domain', 'm', JSON.stringify(specs), STATUS, DATA, web.search ? 1 : 0, web.fetch ? 1 : 0,
      opts.engine ?? null, opts.used ?? null, opts.mode ?? null, opts.cap ?? null)
  const run = db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(rid)
  let sent: any
  let api = ''
  const usage = { prompt_tokens: 900, completion_tokens: 40, ...(opts.cost !== undefined ? { cost: opts.cost } : {}) }
  const openai = {
    chat: { completions: { create: async (args: any) => {
      sent = args; api = 'chat'
      return { choices: [{ message: { content, annotations }, finish_reason: 'stop' }], usage }
    } } },
    // The Responses API, through the SDK's generic post (services/ai-model-call.ts).
    post: async (path: string, { body: args }: { body: any }) => {
      if (path !== '/responses') throw new Error(`unexpected POST ${path}`)
      sent = { ...args }; api = 'responses'
      // Like an OpenAI reasoning model that takes no temperature: refused before anything is generated.
      if (opts.refuseTemperature && 'temperature' in args) {
        throw Object.assign(new Error("400 Unsupported parameter: 'temperature' is not supported with this model."), { status: 400 })
      }
      return {
        status: opts.failed ? 'failed' : 'completed',
        ...(opts.failed ? { error: { message: opts.failed } } : {}),
        output: [
          ...(opts.searches ?? []).map(q => ({
            type: 'openrouter:web_search', status: 'completed',
            action: { type: 'search', query: q.query, ...(q.sources ? { sources: q.sources.map(url => ({ type: 'url', url })) } : {}) },
          })),
          { type: 'message', role: 'assistant', status: 'completed', content: [{
            type: 'output_text', text: content,
            annotations: annotations.map(a => ({ type: 'url_citation', ...a.url_citation })),
          }] },
        ],
        usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, cost: opts.cost },
      }
    },
  }
  await processMultiRow(rid, { rowIndex: 0, data: { domain: 'stripe.com' } }, run as any, openai as any, undefined, 0)
  const result = db.prepare('SELECT scraped_data, cost_usd, web_searches, web_search_queries FROM ai_results WHERE run_id = ?').get(rid) as
    { scraped_data: string | null; cost_usd: number | null; web_searches: number | null; web_search_queries: string | null }
  return {
    cells: cells(sid), sent, api, result,
    scraped: result.scraped_data ? JSON.parse(result.scraped_data) : null,
  }
}

async function webCases() {
  // Fetch only: no citations come back, so the model's own __sources fill "(Data)".
  const f = await webRow({ search: false, fetch: true },
    '{"Score": 9, "Reason": "payments", "__sources": ["https://stripe.com/", "https://stripe.com/payments", "not a url", "https://crunchbase.com/organization/stripe"]}')
  const fetchTool = f.sent.tools?.find((t: any) => t.type === 'openrouter:web_fetch')
  check('fetch-only row stays on Chat Completions', f.api === 'chat')
  check('fetch run sends web_fetch limited to the row\'s own domain', JSON.stringify(fetchTool?.parameters?.allowed_domains) === '["stripe.com"]')
  check('fetch-only run sends no web_search', !f.sent.tools.some((t: any) => t.type === 'openrouter:web_search'))
  check('the instruction asks for __sources', f.sent.messages.at(-1).content.includes('"__sources"'))
  check('fetch run fills the typed columns and ✅', f.cells.Score === '9' && f.cells.Reason === 'payments' && f.cells[STATUS] === '✅')
  check('fetch run fills "(Data)" from __sources (junk and hosts it could not fetch dropped)', f.cells[DATA] === '📊 Read 2 sources: https://stripe.com/, https://stripe.com/payments')
  check('fetch run saves the sources for the viewer', f.scraped?.length === 2)
  check('fetch-only row logs no searches', f.result.web_searches === null && f.result.web_search_queries === null)

  // Search + fetch: citations and __sources merge, each URL once; the row's
  // search words, search count and cost are saved and shown in "(Data)".
  const both = await webRow({ search: true, fetch: true },
    '{"Score": 8, "Reason": "x", "__sources": ["https://stripe.com", "https://stripe.com/pricing"]}',
    [{ type: 'url_citation', url_citation: { url: 'https://stripe.com/', title: 'Stripe', content: 'Payments' } }],
    { searches: [{ query: 'stripe pricing', sources: ['https://stripe.com/'] }], cost: 0.0021 })
  check('search row goes through the Responses API', both.api === 'responses')
  check('search run sends web_search, datetime and web_fetch',
    ['openrouter:web_search', 'openrouter:datetime', 'openrouter:web_fetch'].every(t => both.sent.tools.some((x: any) => x.type === t)))
  check('the Responses call carries the prompt as input', both.sent.input.at(-1).content.includes('"__sources"'))
  check('citations and __sources merge without duplicates; cost first, then searches',
    both.cells[DATA] === '📊 $0.0021 · 1 search: "stripe pricing" · 2 sources: Stripe, https://stripe.com/pricing')
  check('the row saves its cost, searches and search words',
    both.result.cost_usd === 0.0021 && both.result.web_searches === 1
    && both.result.web_search_queries === JSON.stringify([{ query: 'stripe pricing', ran: true }]))

  // A cap of 1 on Parallel: the tool carries engine, mode and max_uses, and of
  // three search calls only the first ran (OpenRouter refused the other two).
  const capped = await webRow({ search: true, fetch: false }, '{"Score": 5, "Reason": "y"}', [],
    { searches: [{ query: 'a', sources: ['https://a.com'] }, { query: 'b' }, { query: 'c' }], cost: 0.0015,
      engine: 'parallel', used: 'parallel', mode: 'fast', cap: 1 })
  const searchTool = capped.sent.tools.find((t: any) => t.type === 'openrouter:web_search')
  check('capped run sends engine, mode and max_uses',
    searchTool.parameters.engine === 'parallel' && searchTool.parameters.mode === 'fast' && searchTool.parameters.max_uses === 1
    && searchTool.parameters.max_total_results === 5)
  check('capped run bounds the tool loop (cap + datetime + one refused ask)', capped.sent.max_tool_calls === 3)
  check('an uncapped run leaves OpenRouter\'s default budget', both.sent.max_tool_calls === undefined)
  check('only the searches that ran count', capped.result.web_searches === 1
    && capped.result.web_search_queries === JSON.stringify([{ query: 'a', ran: true }, { query: 'b', ran: false }, { query: 'c', ran: false }]))
  check('the (Data) cell lists the search that ran', capped.cells[DATA] === '📊 $0.0015 · 1 search: "a"')

  // A model that refuses temperature on the Responses API: sent again without it.
  const noTemp = await webRow({ search: true, fetch: false }, '{"Score": 4, "Reason": "z"}', [],
    { searches: [{ query: 'q', sources: ['https://q.com'] }], cost: 0.0011, refuseTemperature: true })
  check('a refused temperature is dropped and the row still runs',
    noTemp.cells[STATUS] === '✅' && !('temperature' in noTemp.sent) && noTemp.result.cost_usd === 0.0011)

  // A response that came back failed may have run searches already: the row
  // fails, and still records what it cost and searched.
  const failedCall = await webRow({ search: true, fetch: false }, '', [],
    { searches: [{ query: 'f', sources: ['https://f.com'] }], cost: 0.0009, failed: 'Provider down' })
  check('a failed response fails the row but keeps its cost and searches',
    failedCall.cells[STATUS].startsWith('❌') && failedCall.cells[STATUS].includes('Provider down')
    && failedCall.result.cost_usd === 0.0009 && failedCall.result.web_searches === 1)

  // A failed row blanks "(Data)" with the outputs: nothing stays on ⏳. The
  // call was billed, so its cost is kept.
  const bad = await webRow({ search: false, fetch: true }, 'Sorry, I could not open the page.', [], { cost: 0.0004 })
  check('failed web row is ❌ with "(Data)" blank', bad.cells[STATUS].startsWith('❌') && bad.cells[DATA] === '' && !JSON.stringify(bad.cells).includes('⏳'))
  check('a failed row whose call came back keeps its cost', bad.result.cost_usd === 0.0004)

  // No sources at all: the row still succeeds, "(Data)" stays blank.
  const none = await webRow({ search: false, fetch: true }, '{"Score": 3, "Reason": "unknown"}')
  check('no sources → ✅ with a blank "(Data)"', none.cells[STATUS] === '✅' && none.cells[DATA] === '' && none.scraped === null)
}

webCases().then(() => {
  console.log(failures === 0 ? '\nAll structured write-path tests passed' : `\n${failures} FAILURES`)
  if (failures > 0) process.exit(1)
}, (e) => { console.error(e); process.exit(1) })

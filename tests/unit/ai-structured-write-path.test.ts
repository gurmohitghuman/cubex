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
async function webRow(web: { search: boolean; fetch: boolean }, content: string, annotations: unknown[] = []) {
  const sid = uuid(), rid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(['domain', 'Score', 'Reason', STATUS, DATA]))
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,0,?)')
    .run(uuid(), sid, uid, JSON.stringify({ domain: 'stripe.com', Score: '', Reason: '', [STATUS]: '⏳ Processing...', [DATA]: '⏳ Processing...' }))
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,worker_generation,total_rows,processed_rows,
      output_columns,status_column,data_column,use_openrouter_web_search,use_web_fetch)
    VALUES (?,?,?,?,?,?, 'running', 0, 1, 0, ?, ?, ?, ?, ?)`)
    .run(rid, sid, uid, STATUS, 'Score /domain', 'm', JSON.stringify(specs), STATUS, DATA, web.search ? 1 : 0, web.fetch ? 1 : 0)
  const run = db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(rid)
  let sent: any
  const openai = { chat: { completions: { create: async (args: any) => {
    sent = args
    return { choices: [{ message: { content, annotations }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 40 } }
  } } } }
  await processMultiRow(rid, { rowIndex: 0, data: { domain: 'stripe.com' } }, run as any, openai as any, undefined, 0)
  const result = db.prepare('SELECT scraped_data FROM ai_results WHERE run_id = ?').get(rid) as { scraped_data: string | null }
  return { cells: cells(sid), sent, scraped: result.scraped_data ? JSON.parse(result.scraped_data) : null }
}

async function webCases() {
  // Fetch only: no citations come back, so the model's own __sources fill "(Data)".
  const f = await webRow({ search: false, fetch: true },
    '{"Score": 9, "Reason": "payments", "__sources": ["https://stripe.com/", "https://stripe.com/payments", "not a url", "https://crunchbase.com/organization/stripe"]}')
  const fetchTool = f.sent.tools?.find((t: any) => t.type === 'openrouter:web_fetch')
  check('fetch run sends web_fetch limited to the row\'s own domain', JSON.stringify(fetchTool?.parameters?.allowed_domains) === '["stripe.com"]')
  check('fetch-only run sends no web_search', !f.sent.tools.some((t: any) => t.type === 'openrouter:web_search'))
  check('the instruction asks for __sources', f.sent.messages.at(-1).content.includes('"__sources"'))
  check('fetch run fills the typed columns and ✅', f.cells.Score === '9' && f.cells.Reason === 'payments' && f.cells[STATUS] === '✅')
  check('fetch run fills "(Data)" from __sources (junk and hosts it could not fetch dropped)', f.cells[DATA] === '📊 Read 2 sources: https://stripe.com/, https://stripe.com/payments')
  check('fetch run saves the sources for the viewer', f.scraped?.length === 2)

  // Search + fetch: citations and __sources merge, each URL once.
  const both = await webRow({ search: true, fetch: true },
    '{"Score": 8, "Reason": "x", "__sources": ["https://stripe.com", "https://stripe.com/pricing"]}',
    [{ type: 'url_citation', url_citation: { url: 'https://stripe.com/', title: 'Stripe', content: 'Payments' } }])
  check('search run sends web_search, datetime and web_fetch',
    ['openrouter:web_search', 'openrouter:datetime', 'openrouter:web_fetch'].every(t => both.sent.tools.some((x: any) => x.type === t)))
  check('citations and __sources merge without duplicates', both.cells[DATA] === '📊 Searched 2 sources: Stripe, https://stripe.com/pricing')

  // A failed row blanks "(Data)" with the outputs: nothing stays on ⏳.
  const bad = await webRow({ search: false, fetch: true }, 'Sorry, I could not open the page.')
  check('failed web row is ❌ with "(Data)" blank', bad.cells[STATUS].startsWith('❌') && bad.cells[DATA] === '' && !JSON.stringify(bad.cells).includes('⏳'))

  // No sources at all: the row still succeeds, "(Data)" stays blank.
  const none = await webRow({ search: false, fetch: true }, '{"Score": 3, "Reason": "unknown"}')
  check('no sources → ✅ with a blank "(Data)"', none.cells[STATUS] === '✅' && none.cells[DATA] === '' && none.scraped === null)
}

webCases().then(() => {
  console.log(failures === 0 ? '\nAll structured write-path tests passed' : `\n${failures} FAILURES`)
  if (failures > 0) process.exit(1)
}, (e) => { console.error(e); process.exit(1) })

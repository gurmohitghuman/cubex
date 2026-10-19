// Runs against an access token's spend cap (services/token-spend.ts), on a
// migrated throwaway DB with treg stubbed (global fetch) and OpenRouter's
// chat call replaced on the SDK: two enrichment runs sizing rows at the same
// time for one token never buy past its cap; an AI run at the cap starts no
// more rows but lets the ones out finish and write (counted, never aborted),
// pauses itself with token_cap, can't be resumed until the cap is raised and
// then finishes; a token at its cap can't resume the app's run either; an
// auto-run paused at the cap goes on by itself once a row fits again (not
// before: no batch started only to stop); a waterfall's AI part holds room
// for the token; a preview's call that failed after it was billed, and the
// user's own provider key on an AI helper's call, count.
// Over 200 lines: one script over one token's runs; split, each part would rebuild them.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const posts: string[] = []
let callNo = 0
// treg: every POST a paid answer of `costMicro` under a new call id, after `ms`.
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  if (init?.method !== 'POST') return new Response('{}', { status: 404 })
  posts.push(String(input))
  await sleep(60)
  const id = `call-${++callNo}`
  return new Response(JSON.stringify({ output: { email: `${id}@x.example` } }), {
    status: 200, headers: { 'content-type': 'application/json', 'x-treg-call-id': id, 'x-treg-cost-micro': '10000' },
  })
}) as typeof fetch

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { encrypt } = await import('../../server/src/lib/crypto')
  const { saveTregToken, setDailyLimitMicro } = await import('../../server/src/services/treg-key')
  const { setReuseDays } = await import('../../server/src/services/enrich-reuse')
  const { processEnrichmentRun } = await import('../../server/src/services/enrich-runner')
  const { processAIRun } = await import('../../server/src/services/ai-runner')
  const { getOpenRouterClient } = await import('../../server/src/services/openrouter')
  const { resumeRun } = await import('../../server/src/services/run-lifecycle')
  const { resumeEnrichmentRun } = await import('../../server/src/services/enrich-run-status')
  const { getAiRunSummary } = await import('../../server/src/services/run-status')
  const { readTokenSpend, setTokenSpendCap } = await import('../../server/src/services/token-spend')
  const { autorunTick } = await import('../../server/src/services/autorun-loop')
  const { heldMicro, setRunHold, tokenHeldMicro } = await import('../../server/src/services/enrich-holds')
  const { processOneRow } = await import('../../server/src/routes/ai-preview-runner')
  const { askWriterModel } = await import('../../server/src/services/ai-writer-call')
  const { runAs, CUBEX } = await import('../../server/src/lib/actor')
  const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
  type Run = import('../../server/src/services/http-runner-status').HTTPRunRow
  type Config = import('../../server/src/lib/enrich-run-config').EnrichRunConfig
  runMigrations()
  console.warn = () => {}

  const uid = uuid(), tableId = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  saveTregToken(uid, 'treg_test_key')
  setDailyLimitMicro(uid, 100_000_000)
  setReuseDays(uid, 0)
  db.prepare(`INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET openrouter_api_key_encrypted = excluded.openrouter_api_key_encrypted`)
    .run(uuid(), uid, encrypt('sk-or-test'))
  const token = (capUsd: number) => {
    const id = uuid()
    db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, spend_cap_micro)
      VALUES (?,?,?,?,?,?,?)`).run(id, uid, `Agent ${id.slice(0, 6)}`, `h-${id}`, 'cubex_pat_x', 'read,run',
      Math.round(capUsd * 1e6))
    return id
  }
  const spent = (t: string) => readTokenSpend(uid, t)!.spentUsd
  const sheetOf = (columns: string[], rows: Array<Record<string, string>>) => {
    const id = uuid()
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
      .run(id, tableId, uid, `S-${id.slice(0, 8)}`, JSON.stringify(columns))
    rows.forEach((r, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
      .run(uuid(), id, uid, i, JSON.stringify(r)))
    return id
  }
  const cellsOf = (sheetId: string, column: string) => db.prepare(`SELECT json_extract(data, ?) FROM rows
    WHERE sheet_id = ? ORDER BY row_index`).pluck().all(`$."${column}"`, sheetId) as Array<string | null>

  // --- Two enrichment runs at once for one token -------------------------------
  const TOOL = {
    id: 'treg.people.email.find', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
    inputs: [{ name: 'full_name', in: 'body', type: 'string', required: true }],
  }
  const config = {
    requestConfig: { method: 'POST', url: 'x', headers: {}, body: JSON.stringify({ full_name: '{{Name}}' }) },
    responseMapping: [{ columnName: 'Email', jsonPath: '$.output.email' }], batchSize: 5,
    enrichment: {
      v: 1, toolId: TOOL.id, toolName: 'Work email', kind: 'single', preset: null, toolSnapshot: TOOL,
      providerNames: {}, route: { prefer: [], exclude: [], stopAtFirst: false }, cleanDomains: true, fresh: false,
      maxCostPerRowUsd: 0.01, spendLimitUsd: null, rows: { mode: 'all', test: null, where: [] }, email: null,
    },
  }
  const enrichRun = (t: string, rows: number) => {
    const sheetId = sheetOf(['Name', 'Work email', 'Email'],
      Array.from({ length: rows }, (_, i) => ({ Name: `Person ${i}`, 'Work email': PLACEHOLDER })))
    const runId = uuid()
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, total_rows,
      worker_generation, access_token_id) VALUES (?,?,?,?,'running','Work email',?,1,?)`)
      .run(runId, sheetId, uid, JSON.stringify(config), rows, t)
    return runId
  }
  const loadHttp = (id: string) => db.prepare('SELECT * FROM http_runs WHERE id = ?').get(id) as Run & {
    pause_reason: string | null; error_message: string | null; sheet_id: string
  }
  const go = (id: string) => {
    const r = loadHttp(id)
    return processEnrichmentRun(r, JSON.parse(r.config) as Config, 1, null)
  }

  const te = token(0.05)
  const a = enrichRun(te, 5), b = enrichRun(te, 5)
  await Promise.all([go(a), go(b)])
  const runs = [loadHttp(a), loadHttp(b)]
  const paused = runs.filter(r => r.status === 'paused')
  check('two runs for one token sized at once buy no more than its cap', posts.length === 5
    && Math.abs(spent(te) - 0.05) < 1e-9)
  check('... a run left with rows to do paused at the token cap, and says so', paused.length >= 1
    && paused.every(r => r.pause_reason === 'token_cap' && !!r.error_message?.includes('spend cap')))
  check('... and no hold outlives the runs', db.prepare('SELECT COUNT(*) FROM enrich_holds').pluck().get() === 0)
  posts.length = 0
  const late = enrichRun(te, 2)
  await go(late)
  check('a run for a token at its cap buys nothing', posts.length === 0 && loadHttp(late).pause_reason === 'token_cap')
  const raise = await resumeEnrichmentRun(late, uid, 500, undefined)
  check('... and a resume with a higher run limit is refused and changes nothing', 'fail' in raise
    && raise.fail === 'spend_cap' && JSON.parse(loadHttp(late).config).enrichment.spendLimitUsd === null)
  const other = enrichRun(token(1), 2)
  await go(other)
  check("another token's run is not held back by it", posts.length === 2 && loadHttp(other).status === 'running')

  // --- An AI run reaching the cap ----------------------------------------------
  let aiCalls = 0, aborted = 0
  let reply: { content: string; usage: Record<string, unknown> } =
    { content: 'hello', usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.004 } }
  const client = await getOpenRouterClient(uid)
  Object.getPrototypeOf(client.chat.completions).create = async (_body: unknown, opts?: { signal?: AbortSignal }) => {
    aiCalls++
    await sleep(40)
    if (opts?.signal?.aborted) aborted++
    return {
      id: `c${aiCalls}`,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply.content } }],
      usage: reply.usage,
    }
  }
  const ta = token(0.01)
  const aiSheet = sheetOf(['Name', 'Hi (Output)'],
    Array.from({ length: 12 }, (_, i) => ({ Name: `P${i}`, 'Hi (Output)': PLACEHOLDER })))
  const aiRun = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows,
    access_token_id) VALUES (?,?,?,'Hi (Output)','Say hi to /name','test/model',5,'pending',12,?)`)
    .run(aiRun, aiSheet, uid, ta)
  await processAIRun(aiRun, 0)
  const ai = db.prepare('SELECT status, pause_reason, worker_generation FROM ai_runs WHERE id = ?').get(aiRun) as
    { status: string; pause_reason: string | null; worker_generation: number }
  const billed = db.prepare('SELECT COUNT(*) FROM ai_results WHERE run_id = ? AND cost_usd > 0').pluck()
    .get(aiRun) as number
  const written = cellsOf(aiSheet, 'Hi (Output)').filter(v => v === 'hello').length
  check('an AI run at its token cap pauses itself with token_cap',
    ai.status === 'paused' && ai.pause_reason === 'token_cap')
  check('... every call it made came back, was written and counted (none aborted)',
    aiCalls === billed && billed === written && aborted === 0 && Math.abs(spent(ta) - billed * 0.004) < 1e-9)
  // $0.01 is 3 rows at $0.004: the rows out when the third came back (at most the run's 5) are the most over.
  check('... it went past the cap by at most the rows it had out', billed >= 3 && billed <= 3 + 5)
  check('... the rest wait on ⏳',
    cellsOf(aiSheet, 'Hi (Output)').filter(v => v === PLACEHOLDER).length === 12 - written)
  const summary = getAiRunSummary(aiRun, uid) as Record<string, unknown>
  check('... and its status says why', summary.pause_reason === 'token_cap'
    && String(summary.pause_message).includes('spend cap'))
  const refused = await resumeRun('ai', aiRun, uid, true)
  check('a resume is refused while the token is at its cap', 'fail' in refused && refused.fail === 'spend_cap'
    && refused.message.includes('whole life, not a month'))
  // The app's own paused run: a token at its cap restarts no spending, whoever's run it is.
  const appRun = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
    VALUES (?,?,?,'Hi (Output)','p','test/model','paused')`).run(appRun, aiSheet, uid)
  const byToken = await runAs({ ...CUBEX, via: 'mcp', tokenId: ta }, () => resumeRun('ai', appRun, uid, true))
  check("... nor can it resume the app's run", 'fail' in byToken && byToken.fail === 'spend_cap')
  db.prepare("UPDATE ai_runs SET status = 'cancelled' WHERE id = ?").run(appRun)
  setTokenSpendCap(uid, ta, 1_000_000)
  check('... raised, the status says it may go on', String((getAiRunSummary(aiRun, uid) as Record<string, unknown>)
    .pause_message).includes('raised'))
  // What resumeRun does before it queues the job, then the job itself.
  db.prepare(`UPDATE ai_runs SET status = 'pending', worker_generation = worker_generation + 1, pause_reason = NULL
    WHERE id = ?`).run(aiRun)
  await processAIRun(aiRun, ai.worker_generation + 1)
  check('... and resumed it finishes every row, each billed once',
    cellsOf(aiSheet, 'Hi (Output)').every(v => v === 'hello')
    && aiCalls === 12 && Math.abs(spent(ta) - 12 * 0.004) < 1e-9
    && (db.prepare('SELECT status FROM ai_runs WHERE id = ?').pluck().get(aiRun) === 'completed'))

  // --- Auto-run at the cap -------------------------------------------------------
  // A column whose rows are all done (nothing to start): only the pause is looked at.
  const tr = token(0.02)
  const done = enrichRun(tr, 2)
  await go(done)
  const doneSheet = loadHttp(done).sheet_id
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(done)
  const entry = uuid()
  db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, input_columns, daily_cap_micro,
    watermark_row_index, paused_reason, paused_message, paused_at, access_token_id)
    VALUES (?,?,?,'Work email','enrichment','["Name"]',5000000,1,'token_cap','At the cap.',datetime('now'),?)`)
    .run(entry, uid, doneSheet, tr)
  const pauseOf = () => db.prepare('SELECT paused_reason FROM autorun_columns WHERE id = ?').pluck().get(entry)
  await autorunTick(entry)
  check('an auto-run paused at its token cap stays paused while the token is at it', pauseOf() === 'token_cap')
  // Half a row's cap left ($0.01 a row): still no room for one, so no batch starts only to stop.
  setTokenSpendCap(uid, tr, Math.round((spent(tr) + 0.005) * 1e6))
  await autorunTick(entry)
  check('... and while what is left is less than one row', pauseOf() === 'token_cap')
  setTokenSpendCap(uid, tr, 5_000_000)
  await autorunTick(entry)
  check('... and goes on by itself once the cap is raised', pauseOf() === null)

  // --- A waterfall's AI part holds room for its token, not for today's enrichment limit ----
  const tw = token(1)
  const fall = enrichRun(tw, 1)
  db.prepare('UPDATE http_runs SET worker_generation = 1 WHERE id = ?').run(fall)
  db.transaction(() => setRunHold(fall, uid, 1, 20_000, 70_000))()
  check("a run's AI part holds room under its token's cap, its treg part under today's limit too",
    tokenHeldMicro(uid, tw) === 90_000 && heldMicro(uid, fall) === 20_000)
  db.prepare('DELETE FROM enrich_holds WHERE run_id = ?').run(fall)

  // --- A preview's billed call that failed, and an AI helper on the user's own provider key ----
  reply = { content: '', usage: { prompt_tokens: 10, completion_tokens: 900, cost: 0.003 } }
  const empty = await processOneRow({ rowIndex: 0, data: { Name: 'x' } }, client, {
    prompt: 'Say hi to /name', model: 'test/model', safeTemperature: 0.7, search: null, useWebFetch: false,
  })
  check('a preview row whose billed call came back empty is an error that still carries its cost',
    !!empty.error && empty.costUsd === 0.003)
  reply = { content: 'ok', usage: { cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.004 } } }
  const byok = await askWriterModel(client, 'test/model', 'system', 'user', 50)
  check("an AI helper's call says what the user's own provider key billed", byok.cost === 0.001
    && byok.providerCost === 0.004)

  if (failures > 0) { console.error(`${failures} token-cap-runs assertion(s) failed`); process.exit(1) }
  console.log('All token-cap-runs assertions passed.')
  process.exit(0)
}

main().catch(error => { console.error(error); process.exit(1) })

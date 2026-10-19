// An access token's spend when a run stops or changes hands (migrations 042 and
// 045), on a migrated throwaway DB with OpenRouter's chat call replaced on the
// SDK: a paused AI run's calls that came back still count on its usage record
// and its token (single-column, a failed answer, structured; the writers' own
// in-transaction stop too); a run a token resumes becomes that token's, so
// later spend counts against it and the old token keeps what it spent (AI and
// HTTP usage records follow); a token with room may resume a capped token's
// run, the app may not unless that token was revoked (it takes it over); a
// run's own cost counts its dropped calls; a setup at its token's cap pauses before an AI step
// starts, says why, and isn't resumed while the token is still at it.
// Over 200 lines: one script over one account's tokens and runs; split, each part would rebuild them.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { encrypt } = await import('../../server/src/lib/crypto')
  const { processAIRun } = await import('../../server/src/services/ai-runner')
  const { getOpenRouterClient } = await import('../../server/src/services/openrouter')
  const { pauseRun, resumeRun } = await import('../../server/src/services/run-lifecycle')
  const { readTokenSpend, setTokenSpendCap } = await import('../../server/src/services/token-spend')
  const { getAiRunSummary } = await import('../../server/src/services/run-status')
  const { writeFailure, writeSuccess, STOP_SENTINEL } = await import('../../server/src/services/ai-row-writers')
  const { runAs, CUBEX } = await import('../../server/src/lib/actor')
  const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
  const { planApply } = await import('../../server/src/lib/setups/apply-plan')
  const { insertSetup } = await import('../../server/src/services/setup-library')
  const { insertSetupRun, getSetupRun } = await import('../../server/src/services/setup-run-store')
  const { advanceSetupRun } = await import('../../server/src/services/setup-runner')
  const { controlSetupRun } = await import('../../server/src/services/setup-run-control')
  const { sheetCandidates } = await import('../../server/src/services/setup-steps')
  type SetupSpec = import('../../server/src/lib/setups/spec').SetupSpec
  runMigrations()
  console.warn = () => {}

  const uid = uuid(), tableId = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
    .run(uuid(), uid, encrypt('sk-or-test'))
  const token = (capUsd: number) => {
    const id = uuid()
    db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, spend_cap_micro)
      VALUES (?,?,?,?,?,?,?)`).run(id, uid, `Agent ${id.slice(0, 6)}`, `h-${id}`, 'cubex_pat_x', 'read,run',
      Math.round(capUsd * 1e6))
    return id
  }
  const spent = (t: string) => readTokenSpend(uid, t)!.spentUsd
  const as = <T>(t: string, fn: () => T): T => runAs({ ...CUBEX, via: 'mcp', tokenId: t }, fn)
  const sheetOf = (columns: string[], rows: Array<Record<string, string>>) => {
    const id = uuid()
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
      .run(id, tableId, uid, `S-${id.slice(0, 8)}`, JSON.stringify(columns))
    rows.forEach((r, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
      .run(uuid(), id, uid, i, JSON.stringify(r)))
    return id
  }
  const usageOf = (runId: string) => db.prepare(`SELECT ai_cost_usd + provider_cost_usd + enrich_micro / 1e6 AS c,
    access_token_id AS t FROM run_usage WHERE run_id = ?`).get(runId) as { c: number; t: string | null }
  const tokenOf = (table: string, runId: string) =>
    db.prepare(`SELECT access_token_id FROM ${table} WHERE id = ?`).pluck().get(runId)
  const results = (runId: string) => db.prepare('SELECT COUNT(*) FROM ai_results WHERE run_id = ?').pluck()
    .get(runId) as number
  const dropped = (runId: string) => db.prepare('SELECT COUNT(*) FROM ai_dropped_calls WHERE run_id = ?').pluck()
    .get(runId) as number

  // OpenRouter: every call costs $0.004 and waits at the gate.
  let started = 0
  let content = 'hello'
  let open: () => void = () => {}
  let gate: Promise<void> = Promise.resolve()
  const shut = () => { gate = new Promise(r => { open = r }) }
  const client = await getOpenRouterClient(uid)
  Object.getPrototypeOf(client.chat.completions).create = async () => {
    started++
    await gate
    await sleep(5)
    return {
      id: `c${started}`, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.004 },
    }
  }
  const aiRun = (t: string, rows: number, concurrency: number, structured = false) => {
    const status = structured ? 'Hi (Status)' : 'Hi (Output)'
    const sheetId = sheetOf(['Name', status, ...(structured ? ['A'] : [])],
      Array.from({ length: rows }, (_, i) => ({ Name: `P${i}`, [status]: PLACEHOLDER })))
    const id = uuid()
    db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, concurrency, status, total_rows,
      access_token_id, output_columns, status_column) VALUES (?,?,?,?,'Hi /Name','test/model',?,'pending',?,?,?,?)`)
      .run(id, sheetId, uid, status, concurrency, rows, t,
        structured ? JSON.stringify([{ columnName: 'A', type: 'string', description: 'a' }]) : null,
        structured ? status : null)
    return { id, sheetId }
  }
  // Starts the run, pauses it (as the app) once `out` calls are out, then lets them come back.
  const pauseMidFlight = async (runId: string, out: number) => {
    shut()
    started = 0
    const working = processAIRun(runId, 0)
    for (let i = 0; i < 400 && started < out; i++) await sleep(5)
    pauseRun('ai', runId, uid)
    open()
    await working
  }

  // --- A pause drops the rows, never what their calls cost ---------------------
  const t1 = token(1)
  const one = aiRun(t1, 6, 3)
  await pauseMidFlight(one.id, 3)
  check('a paused AI run writes none of the rows whose calls were out', results(one.id) === 0 && started === 3)
  check('... but each billed call counts on its usage record and its token', dropped(one.id) === 3
    && near(usageOf(one.id).c, 0.012) && near(spent(t1), 0.012), [dropped(one.id), usageOf(one.id), spent(t1)])
  check("... and in the run's own cost", near(Number(getAiRunSummary(one.id, uid)?.cost_usd), 0.012))

  content = ''   // an empty answer: the row fails after its call came back, and the run is stopped
  const failedAnswers = aiRun(t1, 4, 2)
  await pauseMidFlight(failedAnswers.id, 2)
  check('... a billed call whose answer failed while the run stopped counts too', results(failedAnswers.id) === 0
    && near(usageOf(failedAnswers.id).c, 0.008) && near(spent(t1), 0.02))

  content = '{"A":"x"}'
  const structured = aiRun(t1, 4, 2, true)
  await pauseMidFlight(structured.id, 2)
  check('... and so does a structured run\'s', results(structured.id) === 0
    && near(usageOf(structured.id).c, 0.008) && near(spent(t1), 0.028))

  // The writers' own check under the write lock (a stop that lands after the early check).
  const ctx = { runId: one.id, userId: uid, sheetId: one.sheetId, rowIndex: 5, columnName: 'Hi (Output)',
    inputValues: '{}', needsDataColumn: false, myGeneration: 0 }
  const usage = { promptTokens: 1, completionTokens: 1, costUsd: 0.001, providerCostUsd: 0.0005 }
  let thrown: unknown = null
  try { writeSuccess(ctx, 'x', null, '', usage) } catch (e) { thrown = e }
  check("a success write for a stopped run rolls back (its caller keeps the call's cost)",
    thrown === STOP_SENTINEL && dropped(one.id) === 3 && near(spent(t1), 0.028))
  writeFailure(ctx, 'boom', usage)
  check("a failure write for a stopped run keeps only the call's cost, the user's own key's too",
    results(one.id) === 0 && dropped(one.id) === 4 && near(spent(t1), 0.0295))

  // --- A token that resumes a run makes it its own --------------------------------
  const t2 = token(1)
  const before = spent(t1)
  const resumeAs = async (t: string | null, kind: 'ai' | 'http', runId: string) => {
    try {
      return await (t ? as(t, () => resumeRun(kind, runId, uid, true)) : resumeRun(kind, runId, uid, true))
    } catch { return { queued: false } }   // no job queue here: the run is put back to paused
  }
  await resumeAs(t2, 'ai', one.id)
  check('a token that resumes a run makes it its own, and its usage record follows',
    tokenOf('ai_runs', one.id) === t2 && usageOf(one.id).t === t2)
  // What resumeRun does before it queues the job, then the job itself.
  const gen = db.prepare('SELECT worker_generation FROM ai_runs WHERE id = ?').pluck().get(one.id) as number
  db.prepare("UPDATE ai_runs SET status = 'pending', worker_generation = ? WHERE id = ?").run(gen + 1, one.id)
  content = 'hello'
  shut(); open()
  await processAIRun(one.id, gen + 1)
  check('... what it spends from then on counts against the token that resumed it', near(spent(t2), 6 * 0.004)
    && db.prepare('SELECT status FROM ai_runs WHERE id = ?').pluck().get(one.id) === 'completed', spent(t2))
  check('... and the token it spent for before keeps what it spent, no more and no less', near(spent(t1), before)
    && near(usageOf(one.id).c, spent(t2) + 0.012 + 0.0015))

  // A capped token's run: the app can't resume it, a token with room can (and pays from then on).
  setTokenSpendCap(uid, t1, 0)
  const byApp = await resumeAs(null, 'ai', failedAnswers.id)
  check("the app can't resume a run whose token is at its cap", 'fail' in byApp && byApp.fail === 'spend_cap'
    && tokenOf('ai_runs', failedAnswers.id) === t1)
  const byOther = await resumeAs(t2, 'ai', failedAnswers.id)
  check('a token with room can, and the run is its own from then on', !('fail' in byOther)
    && tokenOf('ai_runs', failedAnswers.id) === t2)
  const byCapped = await resumeAs(t1, 'ai', structured.id)
  check('a token at its cap resumes nothing', 'fail' in byCapped && byCapped.fail === 'spend_cap')
  // A revoked token's cap can never be raised: the app takes its run over (no token from then on).
  db.prepare("UPDATE access_tokens SET revoked_at = datetime('now') WHERE id = ?").run(t1)
  const takenOver = await resumeAs(null, 'ai', structured.id)
  check("the app takes a revoked token's run over instead of refusing it", !('fail' in takenOver)
    && tokenOf('ai_runs', structured.id) === null && usageOf(structured.id).t === null)

  // An HTTP run's usage record follows its token too (an enrichment's treg spend, a waterfall's AI part).
  const httpRun = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, access_token_id)
    VALUES (?,?,?,'{}','paused','Out',?)`).run(httpRun, one.sheetId, uid, t1)
  db.prepare('UPDATE http_runs SET spent_micro = 1000 WHERE id = ?').run(httpRun)
  const t1Http = spent(t1), t2Http = spent(t2)
  await resumeAs(t2, 'http', httpRun)
  db.prepare('UPDATE http_runs SET spent_micro = 3000 WHERE id = ?').run(httpRun)
  check("an HTTP run a token resumes counts what it spends from then on against that token",
    tokenOf('http_runs', httpRun) === t2 && usageOf(httpRun).t === t2 && near(spent(t2), t2Http + 0.002)
    && near(spent(t1), t1Http))

  // --- A setup at its token's cap pauses before an AI step starts --------------------
  const spec: SetupSpec = { v: 1, inputs: ['Name'], keys: [], steps: [{
    kind: 'ai', name: 'Hello', prompt: 'Say hi to /Name', systemPrompt: null, model: 'test/model', temperature: 0.7,
    maxChars: null, concurrency: null, webSearch: false, webFetch: false, search: null, outputColumns: null,
    runIf: null,
  }] }
  const setup = insertSetup(uid, 'Say hi', null, spec)
  if (!('ok' in setup)) throw new Error(JSON.stringify(setup))
  const setupSheet = sheetOf(['Name'], [{ Name: 'Ada' }, { Name: 'Grace' }])
  const plan = planApply(spec, ['Name'], {}, sheetCandidates(setupSheet, uid))
  if (!('ok' in plan)) throw new Error(JSON.stringify(plan))
  const setupRun = insertSetupRun({ userId: uid, sheetId: setupSheet, setupId: setup.ok.id, setupName: 'Say hi',
    plan: { spec: plan.ok.spec, layers: plan.ok.layers, modes: plan.ok.modes }, targetRowIds: null,
    allowSecrets: false, autoRun: false })
  db.prepare('UPDATE setup_runs SET access_token_id = ? WHERE id = ?').run(token(0), setupRun)
  await advanceSetupRun(setupRun)
  const view = getSetupRun(uid, setupRun)!
  check("a setup at its token's cap pauses before its AI step starts, and says why", view.status === 'paused'
    && view.steps[0].state === 'waiting' && !!view.error_message?.includes('spend cap')
    && !db.prepare('SELECT 1 FROM ai_runs WHERE sheet_id = ?').get(setupSheet), view)
  const again = await controlSetupRun(uid, setupRun, 'resume', true)
  check('... and resuming it is refused while the token is still at its cap', 'fail' in again
    && getSetupRun(uid, setupRun)!.status === 'paused')

  if (failures > 0) { console.error(`${failures} token-spend-moves assertion(s) failed`); process.exit(1) }
  console.log('All token-spend-moves assertions passed.')
  process.exit(0)
}

main().catch(error => { console.error(error); process.exit(1) })

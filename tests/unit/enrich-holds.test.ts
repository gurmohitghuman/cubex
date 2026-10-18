// Holds on the enrichment limits and a run recovering its own paid answers,
// against a migrated throwaway DB and a stubbed treg (global fetch): runs
// sizing rows at the same time never commit more than the daily limit; a
// hold counts while its worker may still have calls out, and boot drops them;
// a run with no per-row cap holds nothing but stops once what treg really
// billed reaches a limit (auto-run's room too); a run paused with calls out
// recovers their paid answers on resume instead of buying them again, and
// never recovers over a row it wrote.
// Over 200 lines: one script over one account's runs; split, each part would rebuild them.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

type Stub = (url: string, init: RequestInit) => Promise<Response>
let stub: Stub = async () => new Response('', { status: 500 })
globalThis.fetch = ((input: string | URL, init?: RequestInit) => stub(String(input), init ?? {})) as typeof fetch
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
let calls = 0
const posts: string[] = []
// A paid answer (or an unmetered one: no cost header) under a new call id.
const answer = (costMicro: number | null) => {
  const id = `call-${++calls}`
  return json({ output: { email: `${id}@x.example` } },
    { 'x-treg-call-id': id, ...(costMicro === null ? {} : { 'x-treg-cost-micro': String(costMicro) }) })
}
const buying = (costMicro: number | null, ms = 100): Stub => async (url, init) => {
  if (init.method !== 'POST') return new Response('{}', { status: 404 })
  posts.push(url)
  await sleep(ms)
  return answer(costMicro)
}

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { saveTregToken, setDailyLimitMicro, spentTodayMicro } = await import('../../server/src/services/treg-key')
  const { processEnrichmentRun, pauseEnrichmentRun } = await import('../../server/src/services/enrich-runner')
  const { heldMicro, setRunHold } = await import('../../server/src/services/enrich-holds')
  const { runSpentMicro } = await import('../../server/src/services/enrich-ledger')
  const { recoverPaidAnswer } = await import('../../server/src/services/enrich-recover')
  const { rowRequest } = await import('../../server/src/services/enrich-row')
  const { resetOrphanedRuns } = await import('../../server/src/lib/orphan-runs')
  const { autorunCapacity } = await import('../../server/src/services/autorun-capacity')
  const { utcDay } = await import('../../server/src/lib/clock')
  const { UNCAPPED_BILLED_NOTE } = await import('../../server/src/lib/enrich-estimate')
  const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
  const { setReuseDays } = await import('../../server/src/services/enrich-reuse')
  type Run = import('../../server/src/services/http-runner-status').HTTPRunRow
  type Config = import('../../server/src/lib/enrich-run-config').EnrichRunConfig
  runMigrations()

  const uid = uuid(), tableId = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  saveTregToken(uid, 'treg_test_key')
  setDailyLimitMicro(uid, 50_000)
  // Every run here enriches the same people: each must call treg (and bill),
  // not reuse the answers an earlier run found (enrich-reuse.test.ts covers that).
  setReuseDays(uid, 0)

  const TOOL = {
    id: 'treg.people.email.find', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
    inputs: [{ name: 'full_name', in: 'body', type: 'string', required: true }],
  }
  const configOf = (cap: number | null) => ({
    requestConfig: { method: 'POST', url: 'x', headers: {}, body: JSON.stringify({ full_name: '{{Name}}' }) },
    responseMapping: [{ columnName: 'Email', jsonPath: '$.output.email' }], batchSize: 5,
    enrichment: {
      v: 1, toolId: TOOL.id, toolName: 'Work email', kind: 'single', preset: null, toolSnapshot: TOOL,
      providerNames: {}, route: { prefer: [], exclude: [], stopAtFirst: false }, cleanDomains: true, fresh: false,
      maxCostPerRowUsd: cap, spendLimitUsd: null, rows: { mode: 'all', test: null, where: [] }, email: null,
    },
  })
  const newRun = (rows: number, cap: number | null) => {
    const sheetId = uuid(), runId = uuid()
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
      .run(sheetId, tableId, uid, `S-${sheetId.slice(0, 8)}`, JSON.stringify(['Name', 'Work email', 'Email']))
    for (let i = 0; i < rows; i++) {
      db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
        .run(uuid(), sheetId, uid, i, JSON.stringify({ Name: `Person ${i}`, 'Work email': PLACEHOLDER }))
    }
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, total_rows,
      worker_generation) VALUES (?,?,?,?,'running','Work email',?,1)`)
      .run(runId, sheetId, uid, JSON.stringify(configOf(cap)), rows)
    return runId
  }
  const load = (id: string) => db.prepare('SELECT * FROM http_runs WHERE id = ?').get(id) as Run & {
    pause_reason: string | null; sheet_id: string
  }
  const go = (id: string, gen: number) => {
    const r = load(id)
    return processEnrichmentRun(r, JSON.parse(r.config) as Config, gen, null)
  }
  const holds = () => db.prepare('SELECT COUNT(*) FROM enrich_holds').pluck().get() as number
  const cells = (id: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
    .pluck().all(load(id).sheet_id) as string[]).map(d => JSON.parse(d) as Record<string, string>)

  // --- Two runs at once against one daily limit --------------------------------
  // $0.05 left, $0.01 a row, 5 rows each: both would fit all 5 on spend alone.
  stub = buying(10_000)
  const a = newRun(5, 0.01), b = newRun(5, 0.01)
  await Promise.all([go(a, 1), go(b, 1)])
  const paused = [load(a), load(b)].filter(r => r.status === 'paused')
  check('two runs sized at once buy no more than the daily limit',
    posts.length === 5 && spentTodayMicro(uid) === 50_000)
  check('the run that found the room held waited for it, then paused at the limit',
    paused.length === 1 && paused[0].pause_reason === 'daily_limit')
  check('no hold outlives its run', holds() === 0)

  // Rows that cost less than their cap give the rest back for other runs.
  setDailyLimitMicro(uid, 80_000)
  posts.length = 0
  stub = buying(4_000)
  const c = newRun(5, 0.01), d = newRun(5, 0.01)
  await Promise.all([go(c, 1), go(d, 1)])
  const bought = cells(c).concat(cells(d)).filter(r => r.Email).length
  check('room a row held but did not spend comes back (more rows than the cap alone allows)',
    bought === posts.length && bought > 3 && spentTodayMicro(uid) <= 80_000)
  check('... and still never past the limit', spentTodayMicro(uid) === 50_000 + bought * 4_000)
  check('... the holds are gone with the runs', holds() === 0)

  // --- Which holds count ---------------------------------------------------------
  const p = newRun(0, 0.01)
  db.prepare("UPDATE http_runs SET status = 'paused', updated_at = datetime('now', '-1 hour') WHERE id = ?").run(p)
  db.prepare('INSERT INTO enrich_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?,?,?,?)')
    .run(p, 1, uid, 70_000)
  check('a hold whose run left that worker long ago counts for nothing', heldMicro(uid) === 0)
  db.prepare("UPDATE http_runs SET updated_at = datetime('now') WHERE id = ?").run(p)
  check('... but counts for a while after a pause: its calls out still bill',
    heldMicro(uid) === 70_000 && heldMicro(uid, p) === 70_000 && heldMicro(uid, a) === 0)
  db.prepare(`UPDATE http_runs SET status = 'running', worker_generation = 2,
    updated_at = datetime('now', '-1 hour') WHERE id = ?`).run(p)
  check("an older worker's hold stops counting once the run moved on", heldMicro(uid) === 0)
  db.transaction(() => setRunHold(a, uid, 1, 0))()
  check('taking a hold clears the ones that no longer count', holds() === 0)
  db.prepare('INSERT INTO enrich_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?,?,?,?)')
    .run(p, 2, uid, 20_000)
  check("the running worker's hold counts", heldMicro(uid) === 20_000)

  // --- A run with no per-row cap -------------------------------------------------
  // The team's own provider key should bill it, so it holds nothing and a
  // limit can't size it; but treg can still charge, and what it charged counts.
  setDailyLimitMicro(uid, spentTodayMicro(uid) + 30_000)
  posts.length = 0
  stub = buying(null, 10)
  const own = newRun(7, null)
  await go(own, 1)
  check('a run billed on the own provider key runs every row while treg charges nothing',
    load(own).status === 'running' && cells(own).every(r => r.Email) && posts.length === 7)
  posts.length = 0
  stub = buying(10_000, 10)
  const billed = newRun(12, null)
  await go(billed, 1)
  const billedRun = load(billed) as Run & { pause_reason: string | null; error_message: string | null }
  // $0.03 left at $0.01 a row: rows start while less than that is billed, so the
  // rows still out then (at most the run's 5) are all it can go over by.
  check('... one treg bills after all stops at the daily limit once those charges reach it',
    billedRun.status === 'paused' && billedRun.pause_reason === 'daily_limit'
      && posts.length >= 3 && posts.length <= 2 + 5)
  check('... and its pause says why', !!billedRun.error_message?.includes('spent today')
    && billedRun.error_message.endsWith(UNCAPPED_BILLED_NOTE))
  posts.length = 0
  const late = newRun(1, null)
  await go(late, 1)
  check('... and another one starts nothing on a spent day',
    load(late).status === 'paused' && load(late).pause_reason === 'daily_limit' && posts.length === 0)

  // Auto-run's room for such a column: the same limits, on what treg charged.
  const auto = uuid()
  const entry = (capMicro: number | null) => ({ id: auto, user_id: uid, daily_cap_micro: capMicro }) as
    Parameters<typeof autorunCapacity>[0]
  const ownConfig = configOf(null) as unknown as Parameters<typeof autorunCapacity>[1]
  const room = autorunCapacity(entry(null), ownConfig)
  check('auto-run: a spent day stops an own-key column too',
    'reason' in room && room.reason === 'daily_limit' && room.message.endsWith(UNCAPPED_BILLED_NOTE))
  setDailyLimitMicro(uid, null)
  const free = autorunCapacity(entry(30_000), ownConfig)
  check('... no limit hit: as many rows as it may take, no run limit', 'rows' in free && free.runLimitUsd === null)
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, autorun_id, autorun_day, spent_micro)
    VALUES (?,?,?,'{}','completed',?,?,30000)`).run(uuid(), load(own).sheet_id, uid, auto, utcDay())
  const capped = autorunCapacity(entry(30_000), ownConfig)
  check("... and a column cap set anyway stops it once treg's charges for the column reach it",
    'reason' in capped && capped.reason === 'column_cap')

  // --- A run paused with a call out, resumed after treg's replay window -----------
  setDailyLimitMicro(uid, null)
  const f = newRun(1, 0.01)
  stub = async (url, init) => {
    if (init.method !== 'POST') return new Response('{}', { status: 404 })
    db.prepare("UPDATE http_runs SET status = 'paused', updated_at = datetime('now') WHERE id = ?").run(f)
    return answer(10_000)
  }
  await go(f, 1)
  const resultRows = () => db.prepare('SELECT COUNT(*) FROM http_results WHERE run_id = ?').pluck().get(f) as number
  check('a pause with a call out: the call is billed, its write dropped, the row still ⏳',
    runSpentMicro(f, uid) === 10_000 && cells(f)[0]['Work email'] === PLACEHOLDER && resultRows() === 0)
  const paidId = db.prepare('SELECT call_id FROM enrichment_calls WHERE run_id = ? AND cost_micro > 0')
    .pluck().get(f) as string
  let gets = 0
  posts.length = 0
  stub = async (url, init) => {
    if (init.method === 'POST') { posts.push(url); return answer(10_000) }   // a replay past 24 h: a new charge
    if (url.endsWith(`/calls/${paidId}/result`)) {
      gets++
      return json({ stored: true, status_code: 200, response: { output: { email: 'kept@x.example' } } })
    }
    return new Response('{}', { status: 404 })
  }
  db.prepare("UPDATE http_runs SET status = 'running', worker_generation = 2 WHERE id = ?").run(f)
  await go(f, 2)
  check('the resume recovers the answer the run paid for instead of buying it again',
    posts.length === 0 && gets === 1 && cells(f)[0].Email === 'kept@x.example')
  const ledger = db.prepare('SELECT IFNULL(SUM(cost_micro), 0) FROM enrichment_calls WHERE run_id = ?').pluck()
  check('... charged once: the run, the ledger and the day agree', runSpentMicro(f, uid) === 10_000
    && ledger.get(f) === 10_000)
  const cost = db.prepare('SELECT cost_usd FROM http_results WHERE run_id = ?').pluck().get(f)
  check('... and the row counts what this run paid for it', cost === 0.01)

  // A row the run wrote is never recovered over.
  const config = JSON.parse(load(f).config) as Config
  const row = db.prepare('SELECT id, data FROM rows WHERE sheet_id = ?').get(load(f).sheet_id) as
    { id: string; data: string }
  const req = rowRequest(config, { rowIndex: 0, rowId: row.id, data: JSON.parse(row.data) }, ['Name', 'Email'])
  if (!('built' in req)) throw new Error('the test row should build a request')
  const parts = { method: req.built.method, path: req.built.path, query: req.built.query, body: req.built.body,
    prefer: [], exclude: [] }
  gets = 0
  const ctx = { runId: f, userId: uid, token: 'treg_test_key' } as Parameters<typeof recoverPaidAnswer>[0]
  check('a row the run wrote offers nothing to recover',
    await recoverPaidAnswer(ctx, row.id, 0, TOOL.id, parts) === null && gets === 0)

  // A pause can carry treg's own words: never a key in them.
  const said = newRun(0, 0.01)
  pauseEnrichmentRun(said, 1, 'auth', 'treg said: key treg_abcdefghijklmnopqrstuvwxyz0123 is not valid')
  const stored = db.prepare('SELECT error_message FROM http_runs WHERE id = ?').pluck().get(said) as string
  check('a pause message is stored redacted', !stored.includes('treg_abcdef') && stored.includes('[REDACTED]'))

  // --- Boot ---------------------------------------------------------------------
  resetOrphanedRuns()
  check('boot drops every hold: no worker survives a restart', holds() === 0)

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall enrichment hold and recovery checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })

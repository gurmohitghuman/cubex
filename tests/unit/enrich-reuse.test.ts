// Reusing found answers across runs and sheets (services/enrich-reuse.ts, the
// row pipeline in services/enrich-row.ts): a run on another sheet fills rows
// whose lookup an earlier run found at $0 with no call and no ledger row,
// keeps calling for the rest, says where each answer came from and counts
// them; "Always call again", the day setting, an answer's age, a pruned answer
// and the estimate's count. A migrated throwaway DB and a stubbed treg.
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// treg: "Nobody" is never found; "Big" answers past what Cubex keeps whole.
const asked: string[] = []
globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
  if (init?.method !== 'POST') return new Response('{}', { status: 404 })
  const name = (JSON.parse(String(init.body)) as { full_name: string }).full_name
  asked.push(name)
  const body = name === 'Nobody' ? { output: {} }
    : name === 'Big' ? { output: { email: 'big@x.example' }, filler: 'x'.repeat(40_000) }
      : { output: { email: `${name.toLowerCase()}@x.example` } }
  const headers = {
    'content-type': 'application/json', 'x-treg-call-id': `c-${asked.length}`, 'x-treg-cost-micro': '1000',
  }
  return new Response(JSON.stringify(body), { status: 200, headers })
}) as typeof fetch

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { saveTregToken, setDailyLimitMicro } = await import('../../server/src/services/treg-key')
  const { utcDay } = await import('../../server/src/lib/clock')
  const { processEnrichmentRun } = await import('../../server/src/services/enrich-runner')
  const { setReuseDays, getReuseDays, reusedRows } = await import('../../server/src/services/enrich-reuse')
  const { countReusable } = await import('../../server/src/services/enrich-reuse-count')
  const { writeEnrichmentResult } = await import('../../server/src/services/enrich-row-write')
  const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
  type Run = import('../../server/src/services/http-runner-status').HTTPRunRow
  type Config = import('../../server/src/lib/enrich-run-config').EnrichRunConfig
  runMigrations()

  const uid = uuid(), tableId = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  saveTregToken(uid, 'treg_test_key')
  const TOOL = {
    id: 'treg.people.email.find', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
    inputs: [{ name: 'full_name', in: 'body', type: 'string', required: true }],
  }
  const EMAIL = [{ columnName: 'Email', jsonPath: '$.output.email' }]
  const configOf = (fresh = false, mapping = EMAIL) => ({
    requestConfig: { method: 'POST', url: 'x', headers: {}, body: JSON.stringify({ full_name: '{{Name}}' }) },
    responseMapping: mapping, batchSize: 2,
    enrichment: {
      v: 1, toolId: TOOL.id, toolName: 'Work email', kind: 'single', preset: null, toolSnapshot: TOOL,
      providerNames: {}, route: { prefer: [], exclude: [], stopAtFirst: false }, cleanDomains: true, fresh,
      maxCostPerRowUsd: 0.01, spendLimitUsd: null, rows: { mode: 'all', test: null, where: [] }, email: null,
    },
  }) as unknown as Config
  const sheet = (name: string, people: string[]) => {
    const id = uuid()
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
      .run(id, tableId, uid, name, JSON.stringify(['Name', 'Work email', 'Email']))
    people.forEach((p, i) => db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
      .run(uuid(), id, uid, i, JSON.stringify({ Name: p })))
    return id
  }
  // A run over every row of the sheet, as a start seeds it, to completion.
  const runOn = async (sheetId: string, fresh = false, mapping = EMAIL) => {
    db.prepare(`UPDATE rows SET data = json_set(data, '$."Work email"', ?) WHERE sheet_id = ?`)
      .run(PLACEHOLDER, sheetId)
    const runId = uuid()
    const n = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(sheetId) as number
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, total_rows,
      worker_generation) VALUES (?,?,?,?,'running','Work email',?,1)`)
      .run(runId, sheetId, uid, JSON.stringify(configOf(fresh, mapping)), n)
    const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as Run
    await processEnrichmentRun(run, configOf(fresh, mapping), 1, null)
    return runId
  }
  const results = (runId: string) => db.prepare(`SELECT row_index, reuse_key, answered_at, cost_usd, response_data,
      extracted_fields FROM http_results WHERE run_id = ? ORDER BY row_index`).all(runId) as Array<{
    row_index: number; reuse_key: string | null; answered_at: string | null; cost_usd: number;
    response_data: string | null; extracted_fields: string;
  }>
  const calls = (runId: string) => db.prepare('SELECT COUNT(*) FROM enrichment_calls WHERE run_id = ?')
    .pluck().get(runId) as number
  const spent = (runId: string) => db.prepare('SELECT spent_micro FROM http_runs WHERE id = ?').pluck().get(runId)

  check('answers are reused for 30 days by default', getReuseDays(uid) === 30)
  const a = sheet('Leads', ['Ada', 'Grace', 'Nobody', 'Big'])
  const runA = await runOn(a)
  const ra = results(runA)
  check('the first run calls every row', asked.length === 4 && calls(runA) === 4)
  check('found answers carry a key and when they were answered',
    !!ra[0].reuse_key && !!ra[1].reuse_key && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(ra[0].answered_at ?? ''))
  check('not found carries none', ra[2].reuse_key === null)
  check('an answer cut down to fit carries none', ra[3].reuse_key === null && ra[3].response_data !== null)

  // Another sheet, same people: their answers come back, the new ones call.
  const b = sheet('Other', ['Ada', 'Grace', 'Nobody', 'Lin'])
  asked.length = 0
  const runB = await runOn(b)
  const rb = results(runB)
  const cellsB = rb.map(r => JSON.parse(r.extracted_fields) as Record<string, string>)
  check('only rows without a found answer call treg', asked.join() === 'Nobody,Lin')
  check('reused rows filled their cells', cellsB[0].Email === 'ada@x.example' && cellsB[1].Email === 'grace@x.example'
    && cellsB[0]['Work email'].startsWith('✅'))
  check('... at $0, with no ledger row', rb[0].cost_usd === 0 && rb[1].cost_usd === 0 && calls(runB) === 2
    && spent(runB) === 2000)
  const note = (JSON.parse(rb[0].response_data!) as { _cubex: { reused_from: Record<string, string> } })._cubex
  const from = note.reused_from
  check('the row says where its answer came from',
    from.run_id === runA && from.sheet_id === a && from.answered_at === ra[0].answered_at)
  check('the run counts its reused rows', reusedRows(runB, uid) === 2)
  check('a reused answer is not a source itself (its age stays the first call\'s)',
    rb[0].reuse_key === null && rb[3].reuse_key !== null)

  // One run's own duplicates share one call as before ("same lookup as row N"), not the index.
  // Two rows at once: the third starts after the first has written its answer.
  const dup = sheet('Dupes', ['Kim', 'Ola', 'Kim'])
  asked.length = 0
  const runDup = await runOn(dup)
  const notes = results(runDup).map(r => (JSON.parse(r.response_data!) as { _cubex: Record<string, unknown> })._cubex)
  check('a run\'s duplicate rows: one call, the copy says which row it shares',
    asked.sort().join() === 'Kim,Ola' && notes[2].same_as_row_index === 0 && !('reused_from' in notes[2]))

  const plan = (sheetId: string, fresh = false) => ({
    sheetId, rowFilter: { clause: '', params: [] }, targets: null, limit: 4,
    plan: { statusColumn: null, status: 'any' as const, where: [], rule: null, config: configOf(fresh),
      columns: ['Name', 'Work email', 'Email'] },
  })
  const count = await countReusable(uid, plan(b))
  check('the estimate counts the rows that would reuse (Ada, Grace, Lin)',
    count.rows === 3 && count.checked === 4 && count.complete && count.days === 30)
  check('... none when the run calls every row again', (await countReusable(uid, plan(b, true))).rows === 0)
  const many = sheet('Many', Array.from({ length: 600 }, () => 'Ada'))
  const slow = await countReusable(uid, { ...plan(many), limit: 600 }, -1)
  check('a count out of time stops after a page and says it is a floor',
    !slow.complete && slow.checked === 500 && slow.rows === 500)
  const whole = await countReusable(uid, { ...plan(many), limit: 600 })
  check('... and with time it counts every row', whole.complete && whole.rows === 600)
  const tail = await countReusable(uid, { ...plan(many), targets: [599, 598], limit: 2 }, -1)
  check('selected rows far down a big sheet are read by their numbers',
    tail.complete && tail.checked === 2 && tail.rows === 2)

  asked.length = 0
  const runFresh = await runOn(b, true)
  check('"Always call again" calls every row', asked.length === 4 && reusedRows(runFresh, uid) === 0)

  setReuseDays(uid, 0)
  asked.length = 0
  await runOn(b)
  check('0 days: every row calls', asked.length === 4)

  // An answer older than the setting is not reused.
  setReuseDays(uid, 1)
  db.prepare(`UPDATE http_results SET answered_at = datetime('now', '-2 days') WHERE reuse_key IS NOT NULL`).run()
  const c = sheet('Third', ['Ada'])
  asked.length = 0
  await runOn(c)
  check('an answer older than the days set calls again', asked.join() === 'Ada')

  // Settings' prune keeps the output: the answer still fills a row.
  setReuseDays(uid, 30)
  const graceKey = results(runFresh)[1].reuse_key
  db.prepare(`UPDATE http_results SET response_data = json_set(json_remove(response_data, '$.filler'),
    '$."$prunedAt"', '2026-10-01') WHERE reuse_key = ?`).run(graceKey)
  const d = sheet('Fourth', ['Grace'])
  asked.length = 0
  const runD = await runOn(d)
  const cellD = JSON.parse(results(runD)[0].extracted_fields) as Record<string, string>
  check('a pruned answer is still reused', asked.length === 0 && cellD.Email === 'grace@x.example')
  check('... and its copy keeps the prune note',
    (JSON.parse(results(runD)[0].response_data!) as Record<string, unknown>).$prunedAt === '2026-10-01')
  // A column reading the raw part a prune dropped can't fill from it: that row calls.
  asked.length = 0
  await runOn(sheet('Raw', ['Grace']), false, [...EMAIL, { columnName: 'Note', jsonPath: '$.raw.note' }])
  check('a run reading a pruned raw part calls again', asked.join() === 'Grace')
  // A single tool run with no outputs counts every answer as found: nothing is keyed.
  const quiet = await runOn(sheet('Quiet', ['Una']), false, [])
  check('a run with no outputs keys nothing', results(quiet)[0].reuse_key === null)

  // Answers kept by sheets in the trash aren't reused (they come back with the sheet).
  const keyed = db.prepare(`SELECT DISTINCT h.sheet_id FROM http_results r JOIN http_runs h ON h.id = r.run_id
    WHERE r.reuse_key IS NOT NULL`).pluck().all() as string[]
  const trashSet = db.prepare('UPDATE sheets SET trash_id = ? WHERE id IN (SELECT value FROM json_each(?))')
  trashSet.run(999_999, JSON.stringify(keyed))
  asked.length = 0
  await runOn(sheet('Trashed', ['Grace']))
  check("an answer from a sheet in the trash isn't reused", asked.join() === 'Grace')
  trashSet.run(null, JSON.stringify(keyed))

  // A spent day stops the rows that would cost; rows reusing an answer still fill.
  setDailyLimitMicro(uid, 10_000)
  db.prepare(`INSERT INTO enrich_daily_spend (user_id, day, spent_micro) VALUES (?, ?, 10000)
    ON CONFLICT(user_id, day) DO UPDATE SET spent_micro = 10000`).run(uid, utcDay())
  const spentSheet = sheet('Spent', ['Ada', 'Grace', 'Newcomer'])
  asked.length = 0
  const runSpent = await runOn(spentSheet)
  const spentCells = (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
    .all(spentSheet) as string[]).map(d => (JSON.parse(d) as Record<string, string>)['Work email'])
  const paused = db.prepare('SELECT status, pause_reason FROM http_runs WHERE id = ?').get(runSpent) as
    { status: string; pause_reason: string }
  check('free rows run past a spent day; the paid one waits ⏳ and the run pauses on the limit',
    asked.length === 0 && spentCells[0].startsWith('✅') && spentCells[1].startsWith('✅')
      && spentCells[2] === PLACEHOLDER && paused.status === 'paused' && paused.pause_reason === 'daily_limit')
  setDailyLimitMicro(uid, null)

  const plan2 = db.prepare(`EXPLAIN QUERY PLAN
    SELECT r.response_data FROM http_results r JOIN http_runs h ON h.id = r.run_id
    WHERE r.user_id = ? AND r.reuse_key = ? AND r.answered_at >= ? ORDER BY r.answered_at DESC LIMIT 1`)
    .all(uid, 'k', '2026-01-01') as Array<{ detail: string }>
  check('the lookup reads the reuse index, never a scan',
    plan2.some(p => p.detail.includes('idx_http_results_reuse')) && !plan2.some(p => /SCAN r\b/.test(p.detail)))

  // Writing a row's result again (a resume after its input changed) clears a key it no longer answers.
  const own = await runOn(sheet('Fifth', ['Zed']))
  check('a new lookup gets a key', results(own)[0].reuse_key !== null)
  const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(own) as Run
  writeEnrichmentResult({
    run, generation: 1, rowIndex: 0, mapping: configOf().responseMapping, costMicro: 0, request: {},
    cells: { status: 'completed', statusCell: '⏭️ Not found', answer: { output: {} }, fill: 'none', reason: null },
    stored: { output: {} }, reuseKey: null,
  })
  check('... and loses it when the row is written again without one',
    results(own)[0].reuse_key === null && results(own)[0].answered_at === null)
  const bad = db.prepare(`SELECT COUNT(*) FROM http_results
    WHERE reuse_key IS NOT NULL AND (status != 'completed' OR response_data IS NULL)`).pluck().get() as number
  check('every keyed result is completed with an answer', bad === 0)

  console.log(failures === 0 ? '\nall answer reuse checks passed' : `\n${failures} FAILURES`)
  if (failures > 0) process.exit(1)
}
main().catch(e => { console.error(e); process.exit(1) })

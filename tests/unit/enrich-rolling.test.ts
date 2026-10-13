// An enrichment run keeps its concurrency's rows out at once and starts the
// next row as soon as one finishes (services/enrich-runner.ts): one slow row
// must not hold the others back, as a batch waiting for its slowest row did.
// A migrated throwaway DB and a stubbed treg (global fetch).
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let calls = 0
let out = 0
let most = 0
const events: string[] = []
// Person 0 takes 400 ms, everyone else 20 ms.
globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
  if (init?.method !== 'POST') return new Response('{}', { status: 404 })
  const name = (JSON.parse(String(init.body)) as { full_name: string }).full_name
  events.push(`start ${name}`)
  most = Math.max(most, ++out)
  await sleep(name === 'Person 0' ? 400 : 20)
  out--
  events.push(`end ${name}`)
  const id = `call-${++calls}`
  return new Response(JSON.stringify({ output: { email: `${id}@x.example` } }), {
    status: 200, headers: { 'content-type': 'application/json', 'x-treg-call-id': id, 'x-treg-cost-micro': '1000' },
  })
}) as typeof fetch

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { saveTregToken, setDailyLimitMicro } = await import('../../server/src/services/treg-key')
  const { processEnrichmentRun } = await import('../../server/src/services/enrich-runner')
  const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
  type Run = import('../../server/src/services/http-runner-status').HTTPRunRow
  type Config = import('../../server/src/lib/enrich-run-config').EnrichRunConfig
  runMigrations()

  const uid = uuid(), tableId = uuid(), sheetId = uuid(), runId = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  saveTregToken(uid, 'treg_test_key')
  const TOOL = {
    id: 'treg.people.email.find', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
    inputs: [{ name: 'full_name', in: 'body', type: 'string', required: true }],
  }
  const config = {
    requestConfig: { method: 'POST', url: 'x', headers: {}, body: JSON.stringify({ full_name: '{{Name}}' }) },
    responseMapping: [{ columnName: 'Email', jsonPath: '$.output.email' }], batchSize: 2,
    enrichment: {
      v: 1, toolId: TOOL.id, toolName: 'Work email', kind: 'single', preset: null, toolSnapshot: TOOL,
      providerNames: {}, route: { prefer: [], exclude: [], stopAtFirst: false }, cleanDomains: true, fresh: false,
      maxCostPerRowUsd: 0.01, spendLimitUsd: null, rows: { mode: 'all', test: null, where: [] }, email: null,
    },
  }
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(sheetId, tableId, uid, 'S', JSON.stringify(['Name', 'Work email', 'Email']))
  for (let i = 0; i < 8; i++) {
    db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
      .run(uuid(), sheetId, uid, i, JSON.stringify({ Name: `Person ${i}`, 'Work email': PLACEHOLDER }))
  }
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, total_rows,
    worker_generation) VALUES (?,?,?,?,'running','Work email',8,1)`).run(runId, sheetId, uid, JSON.stringify(config))

  // A hold this worker failed to give back (say the DB was busy) that alone
  // fills today's $1: the next sizing corrects it rather than wait forever.
  setDailyLimitMicro(uid, 1_000_000)
  db.prepare('INSERT INTO enrich_holds (run_id, worker_generation, user_id, hold_micro) VALUES (?,?,?,?)')
    .run(runId, 1, uid, 5_000_000)
  const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as Run
  await processEnrichmentRun(run, JSON.parse(run.config as unknown as string) as Config, 1, null)

  const cells = (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheetId) as
    string[]).map(d => JSON.parse(d) as Record<string, string>)
  check('a stale hold of its own did not stall the run (it was set back to the rows out)',
    db.prepare('SELECT status FROM http_runs WHERE id = ?').pluck().get(runId) === 'running')
  check('every row was enriched', cells.every(c => c.Email?.endsWith('@x.example')) && calls === 8)
  check('never more rows out than its concurrency (2)', most === 2)
  const slowEnd = events.indexOf('end Person 0')
  check('the other rows ran past the slow one', events.indexOf('end Person 7') < slowEnd)
  const progress = db.prepare('SELECT processed_rows FROM http_runs WHERE id = ?').pluck().get(runId)
  check('progress counted every row', progress === 8)
  check('no hold is left', db.prepare('SELECT COUNT(*) FROM enrich_holds').pluck().get() === 0)
  console.log(failures === 0 ? '\nenrich-rolling: all passed' : `\n${failures} FAILURES`)
  if (failures > 0) process.exit(1)
}
main().catch(e => { console.error(e); process.exit(1) })

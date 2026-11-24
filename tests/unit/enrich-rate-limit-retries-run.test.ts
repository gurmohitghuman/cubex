// Provider 429 retries at run time (rate_limit_retries, 0-10, default 5): an enrichment row's call, a
// waterfall step, and a verified email row, whose finds and checks share one count.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.ENRICH_PROVIDER_RATE_RETRY_MS = '5'
process.env.ENRICH_PROVIDER_RATE_RETRY_MAX_MS = '20'
process.env.ENRICH_RETRY_MS = '5'

const fixture = JSON.parse(fs.readFileSync('tests/mock-treg/fixtures/calls/verify-nobody.json', 'utf8'))
let calls = 0
const sent: Array<{ path: string; body: string }> = []
// Whether the case's nth call (from 1) answers 429 on every provider.
let fails: (n: number) => boolean = () => false
const routeFailed = () => new Response(JSON.stringify({
  detail: {
    error: 'route_failed', charged_micro: 0,
    tried: [
      { provider: 'contactout', outcome: 'error', status: 429, charged_micro: 0, detail: '{"message":"Too Many"}' },
    ],
  },
}), {
  status: 502, headers: { 'content-type': 'application/json', 'x-treg-error': '1', 'x-treg-call-id': `c-${++calls}` },
})
const found = {
  output: { email: 'ada@acme.example', verified: false },
  _treg: { served_by: 'hunter', tried: [{ provider: 'hunter', outcome: 'hit', status: 200, charged_micro: 1000 }] },
}

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input)
  sent.push({ path: new URL(url).pathname, body: String(init?.body ?? '') })
  if (fails(sent.length)) return routeFailed()
  return new Response(JSON.stringify(url.includes('email.find') ? found : fixture.response.body), {
    status: 200,
    headers: { ...fixture.response.headers, 'x-treg-call-id': `c-${++calls}` },
  })
}) as typeof fetch

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { saveTregToken } = await import('../../server/src/services/treg-key')
const { setReuseDays } = await import('../../server/src/services/enrich-reuse')
const { processEnrichmentRun } = await import('../../server/src/services/enrich-runner')
const { processWaterfallRun } = await import('../../server/src/services/waterfall-runner')
const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
type HTTPRunRow = import('../../server/src/services/http-runner-status').HTTPRunRow
type EnrichRunConfig = import('../../server/src/lib/enrich-run-config').EnrichRunConfig
type WaterfallRunConfig = import('../../server/src/lib/waterfall/config').WaterfallRunConfig

runMigrations()

let failures = 0
async function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`  ok - ${name}`) }
  catch (err) { failures++; console.error(`  FAIL - ${name}:`, err) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['Email', 'Verify', 'Status', 'WF', 'Answered by', 'Step']))
saveTregToken(uid, 'treg_test_key')
setReuseDays(uid, 0)

const tool = (id: string) => ({
  id, method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
  inputs: [{ name: 'email', in: 'body', type: 'string', required: true }],
})
const VERIFY_TOOL = tool('treg.people.email.verify')
const FIND_TOOL = tool('treg.people.email.find')

// Runs one row of master column `column` and returns the paths it called and the cell it wrote.
async function runOne(
  column: string, config: object, failing: (n: number) => boolean,
  go: (run: HTTPRunRow) => Promise<unknown>,
): Promise<{ calls: number; paths: string[]; cell: string }> {
  db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(sid)
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), sid, uid, 0, JSON.stringify({ Email: 'a@acme.example', [column]: PLACEHOLDER }))
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs
    (id,sheet_id,user_id,master_column_name,config,status,total_rows,processed_rows,worker_generation)
    VALUES (?,?,?,?,?,'running',1,0,1)`).run(runId, sid, uid, column, JSON.stringify(config))
  const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as HTTPRunRow
  sent.length = 0
  fails = failing
  await go(run)
  const row = db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(sid) as string
  return { calls: sent.length, paths: sent.map(s => s.path), cell: String(JSON.parse(row)[column] ?? '') }
}

function enrichConfig(rateLimitRetries: number | undefined, verifiedEmail = false): EnrichRunConfig {
  const t = verifiedEmail ? FIND_TOOL : VERIFY_TOOL
  return {
    requestConfig: { method: 'POST', url: `https://treg.to/call/${t.id}`, headers: {}, body: '{"email":"{{Email}}"}' },
    responseMapping: [{ columnName: 'Status', jsonPath: '$.output.status' }],
    previewSize: 5,
    enrichment: {
      v: 1, toolId: t.id, toolName: 'Verify', kind: 'waterfall', preset: verifiedEmail ? 'verified_email' : null,
      toolSnapshot: t, providerNames: { contactout: 'ContactOut' },
      route: { prefer: [], exclude: [], stopAtFirst: false },
      cleanDomains: true, fresh: false,
      ...(rateLimitRetries !== undefined ? { rateLimitRetries } : {}),
      maxCostPerRowUsd: 0.02, spendLimitUsd: 1, rows: { mode: 'all', test: null, where: [] },
      email: verifiedEmail
        ? {
          strategy: 'balanced', guess: false, pattern: 'flast', verifyTool: VERIFY_TOOL, verifyExclude: [],
          verifyKind: 'waterfall',
        }
        : null,
    },
  }
}

const enrichRun = (config: EnrichRunConfig, failing: (n: number) => boolean) =>
  runOne('Verify', config, failing, run => processEnrichmentRun(run, config, 1, null))
const firstFail = (k: number) => (n: number) => n <= k

await ok('runtime enrichment retries honor 0, 2, 7 and default 5 on 429s', async () => {
  const zero = await enrichRun(enrichConfig(0), firstFail(10))
  assert.equal(zero.calls, 1)
  assert.match(zero.cell, /429/)

  const twoOk = await enrichRun(enrichConfig(2), firstFail(2))
  assert.equal(twoOk.calls, 3)
  assert.match(twoOk.cell, /^✅/)

  const twoFail = await enrichRun(enrichConfig(2), firstFail(10))
  assert.equal(twoFail.calls, 3)
  assert.match(twoFail.cell, /429/)

  const sevenOk = await enrichRun(enrichConfig(7), firstFail(7))
  assert.equal(sevenOk.calls, 8)
  assert.match(sevenOk.cell, /^✅/)

  const defFail = await enrichRun(enrichConfig(undefined), firstFail(20))
  assert.equal(defFail.calls, 6)
  assert.match(defFail.cell, /429/)
})

await ok('a verified email row\'s finds and checks share one count of 2, not 5 and not 2 each', async () => {
  const kinds = (paths: string[]) => paths.map(p => (p.includes('email.verify') ? 'v' : 'f')).join('')
  // Every call answers 429: the find and its 2 retries, then the row fails.
  const all = await enrichRun(enrichConfig(2, true), () => true)
  assert.equal(kinds(all.paths), 'fff')
  assert.match(all.cell, /429/)
  // Only the second call answers. The find's retry uses 1 of the 2, the check's first retry the other, and
  // the next find has none left: 5 calls (8 with 5 shared or with 2 each).
  const shared = await enrichRun(enrichConfig(2, true), n => n !== 2)
  assert.equal(kinds(shared.paths), 'ffvvf')
  assert.match(shared.cell, /429/)
})

await ok('waterfall enrichment step honors rateLimitRetries (0 vs 2)', async () => {
  const wfConfig = (rateLimitRetries: number): WaterfallRunConfig => ({
    requestConfig: { method: 'POST', url: '', headers: {}, body: '{"email":"{{Email}}"}' },
    responseMapping: [
      { columnName: 'Answered by', jsonPath: '$.answered_by' },
      { columnName: 'Step', jsonPath: '$.steps.s111111' },
    ],
    previewSize: 5,
    waterfall: {
      v: 1, resultType: 'email', inputs: [{ key: 'email', label: 'Email' }],
      steps: [{
        id: 's111111', label: 'Find', on: true, requires: [['email']],
        choices: {
          kind: 'enrichment', toolId: FIND_TOOL.id, inputs: { email: 'email' },
          providerOrder: [], skipProviders: [], stopAtFirst: false, valuePath: '$.output.email', maxCostUsd: 0.02,
        },
        built: {
          kind: 'enrichment', toolName: 'Find', toolKind: 'waterfall', toolSnapshot: FIND_TOOL,
          route: { prefer: [], exclude: [], stopAtFirst: false }, providerNames: { contactout: 'ContactOut' },
          capUsd: 0.02, valuePath: '$.output.email', cleanDomains: true,
        },
      }],
      hideStepColumns: true, maxCostPerRowUsd: 0.02, tregCapPerRowUsd: 0.02, spendLimitUsd: 1,
      rows: { mode: 'all', status: 'any', test: null }, fresh: false, rateLimitRetries,
    },
  })
  const runWf = (rateLimitRetries: number, failing: (n: number) => boolean) => {
    const config = wfConfig(rateLimitRetries)
    return runOne('WF', config, failing, run => processWaterfallRun(run, config, 1, null))
  }
  const zero = await runWf(0, firstFail(10))
  assert.equal(zero.calls, 1)
  assert.match(zero.cell, /429/)

  const twoOk = await runWf(2, firstFail(2))
  assert.equal(twoOk.calls, 3)
  assert.equal(twoOk.cell, 'ada@acme.example')
})

if (failures > 0) process.exitCode = 1
else console.log('enrich-rate-limit-retries-run: all passed')

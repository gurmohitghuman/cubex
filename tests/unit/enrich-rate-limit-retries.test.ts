// Per-run provider rate-limit retries (rate_limit_retries, 0-10, default 5):
// strict parsing on enrichment and waterfall starts (app, REST and MCP),
// recall on reruns and saved setups, and runtime retry counts (0, 2, 7 and
// default 5) across enrichment runs, verified_email loops and waterfall steps.
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
let failLeft = 0
const routeFailed = () => new Response(JSON.stringify({
  detail: {
    error: 'route_failed', charged_micro: 0,
    tried: [{ provider: 'contactout', outcome: 'error', status: 429, charged_micro: 0, detail: '{"message":"Too Many"}' }],
  },
}), { status: 502, headers: { 'content-type': 'application/json', 'x-treg-error': '1', 'x-treg-call-id': `c-${++calls}` } })

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input)
  sent.push({ path: new URL(url).pathname, body: String(init?.body ?? '') })
  if (failLeft > 0) { failLeft--; return routeFailed() }
  const body = url.includes('email.find')
    ? { output: { email: 'ada@acme.example', verified: false }, _treg: { served_by: 'hunter', tried: [{ provider: 'hunter', outcome: 'hit', status: 200, charged_micro: 1000 }] } }
    : fixture.response.body
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...fixture.response.headers, 'x-treg-call-id': `c-${++calls}` },
  })
}) as typeof fetch

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { saveTregToken } = await import('../../server/src/services/treg-key')
const { setReuseDays } = await import('../../server/src/services/enrich-reuse')
const { parseEnrichRunInput } = await import('../../server/src/lib/enrich-run-input')
const { agentRunBody, unknownArgument } = await import('../../server/src/lib/enrich-agent-input')
const { parseWaterfallInput } = await import('../../server/src/lib/waterfall/input')
const { agentWaterfallBody } = await import('../../server/src/lib/waterfall/agent-args')
const { recallChoices, rerunInput } = await import('../../server/src/lib/enrich-run-recall')
const { enrichRateLimitRetries } = await import('../../server/src/lib/enrich-run-config')
const { recallInput } = await import('../../server/src/services/waterfall-column')
const { agentSetup } = await import('../../server/src/services/waterfall-agent-view')
const { readStep } = await import('../../server/src/lib/setups/check-shape')
const { processEnrichmentRun } = await import('../../server/src/services/enrich-runner')
const { processWaterfallRun } = await import('../../server/src/services/waterfall-runner')
const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
type HTTPRunRow = import('../../server/src/services/http-runner-status').HTTPRunRow
type EnrichRunConfig = import('../../server/src/lib/enrich-run-config').EnrichRunConfig
type WaterfallRunConfig = import('../../server/src/lib/waterfall/config').WaterfallRunConfig
type EnrichTool = import('../../server/src/lib/enrich-tool').EnrichTool

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

const baseEnrich = {
  toolId: 'treg.people.email.verify', preset: null, columnName: 'Verify', continueColumn: false,
  inputs: { email: { column: 'Email' } }, cleanDomains: true, providerOrder: [], skipProviders: [],
  stopAtFirst: false, email: null, outputs: [], rows: { mode: 'all', status: 'any', test: false },
  conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
}

const baseWaterfall = {
  columnName: 'WF', continueColumn: false, resultType: 'email',
  inputs: [{ key: 'email', label: 'Email', source: { column: 'Email' } }],
  steps: [{ id: 's111111', label: 'Formula', on: true, requires: null, choices: { kind: 'formula', formula: '{{email}}' } }],
}

await ok('parseEnrichRunInput and parseWaterfallInput enforce 0..10 whole numbers', () => {
  assert.equal(enrichRateLimitRetries(undefined), 5)
  assert.equal(enrichRateLimitRetries(0), 0)
  assert.equal(enrichRateLimitRetries(10), 10)
  assert.equal(enrichRateLimitRetries(99), 10)
  for (const good of [undefined, null, 0, 1, 5, 10]) {
    const e = parseEnrichRunInput({ ...baseEnrich, rateLimitRetries: good })
    assert.ok('ok' in e, `enrich good ${String(good)}: ${JSON.stringify(e)}`)
    assert.equal(e.ok.rateLimitRetries, good ?? null)
    const w = parseWaterfallInput({ ...baseWaterfall, ...(good !== undefined ? { rateLimitRetries: good } : {}) })
    assert.ok('ok' in w, `waterfall good ${String(good)}: ${JSON.stringify(w)}`)
    assert.equal(w.ok.rateLimitRetries, good ?? null)
  }
  for (const bad of [-1, 11, 2.5, '5', true, NaN]) {
    const e = parseEnrichRunInput({ ...baseEnrich, rateLimitRetries: bad })
    assert.ok('error' in e && /rateLimitRetries.*0 to 10/.test(e.error), `enrich bad ${String(bad)}`)
    const w = parseWaterfallInput({ ...baseWaterfall, rateLimitRetries: bad })
    assert.ok('error' in w && /rateLimitRetries.*0 to 10/.test(w.error), `waterfall bad ${String(bad)}`)
  }
})

await ok('agent args accept rate_limit_retries and preserve it on recall/reruns/setups', () => {
  const tool: EnrichTool = {
    id: 'treg.people.email.verify', name: 'Verify', description: '', category: 'email', capability: 'people.email.verify',
    kind: 'waterfall', method: 'POST', provider: 'treg', providerName: 'treg',
    price: { type: 'per_call', usd: 0.01, overflowUsd: null, lowUsd: 0.01, highUsd: 0.02 },
    inputs: [{ name: 'email', in: 'body', type: 'string', required: true, description: '' }],
    outputs: [{ field: 'status', path: '$.output.status', type: 'string', description: '', defaultOn: true }],
    providers: [{ provider: 'contactout', name: 'ContactOut', priceUsd: 0.01, hitRate: 0.9, unavailable: false }],
    identitySets: null, derive: null, queryArrayEncoding: null, list: null, otherLists: [],
  }
  assert.equal(unknownArgument({ sheet_id: sid, tool_id: tool.id, column_name: 'Verify', rate_limit_retries: 3 }), null)
  const body = agentRunBody({
    tool_id: tool.id, column_name: 'Verify', inputs: { email: 'Email' },
    outputs: [{ field: 'status', column_name: 'Status' }], rate_limit_retries: 3,
  }, tool, null, null)
  assert.ok(!('error' in body))
  assert.equal(body.rateLimitRetries, 3)

  const storedEnrich = {
    requestConfig: { method: 'POST', url: 'https://treg.to/call/treg.people.email.verify', headers: {}, body: '{"email":"{{Email}}"}' },
    responseMapping: [{ columnName: 'Status', jsonPath: '$.output.status' }],
    previewSize: 5,
    enrichment: {
      v: 1, toolId: tool.id, toolName: 'Verify', kind: 'waterfall', preset: null,
      toolSnapshot: { id: tool.id, method: 'POST', inputs: tool.inputs, identitySets: null, derive: null, queryArrayEncoding: null },
      providerNames: { contactout: 'ContactOut' }, route: { prefer: [], exclude: [], stopAtFirst: false },
      cleanDomains: true, fresh: false, rateLimitRetries: 2, maxCostPerRowUsd: 0.02, spendLimitUsd: 1,
      rows: { mode: 'all', test: null, where: [] }, email: null,
    },
  } as unknown as EnrichRunConfig
  const recalled = recallChoices(storedEnrich, 'Verify')
  assert.equal(recalled.rateLimitRetries, 2)
  assert.equal(rerunInput(recalled, { mode: 'all', status: 'failed', test: null, rowIndexes: null }).rateLimitRetries, 2)

  const stepRead = readStep({
    kind: 'enrichment', name: 'Verify', toolId: tool.id, toolName: 'Verify', preset: null,
    inputs: { email: { column: 'Email' } }, cleanDomains: true, providerOrder: [], skipProviders: [],
    stopAtFirst: false, email: null, outputs: [], conditions: [], runIf: null, maxCostPerRowUsd: 0.02,
    concurrency: null, rateLimitRetries: 8, fresh: false, autoRun: null,
  })
  assert.ok('ok' in stepRead && stepRead.ok.kind === 'enrichment' && stepRead.ok.rateLimitRetries === 8)

  const storedWf = {
    requestConfig: { method: 'POST', url: '', headers: {}, body: '{"email":"{{Email}}"}' },
    responseMapping: [{ columnName: 'Answered by', jsonPath: '$.answered_by' }],
    previewSize: 5,
    waterfall: {
      v: 1, resultType: 'email', inputs: [{ key: 'email', label: 'Email' }], steps: [],
      hideStepColumns: true, maxCostPerRowUsd: 0.02, tregCapPerRowUsd: 0.02, spendLimitUsd: 1,
      rows: { mode: 'all', status: 'any', test: null }, fresh: false, rateLimitRetries: 7,
    },
  } as unknown as WaterfallRunConfig
  const wfRecalled = recallInput(storedWf, 'WF')
  assert.equal(wfRecalled.rateLimitRetries, 7)
  const described = agentSetup({
    input: wfRecalled, columns: { answeredBy: 'Answered by', steps: {} }, activeRunId: null, autoRun: false,
    toolNames: {}, sheetNames: {},
  }, { secrets: false })
  assert.equal(described.rate_limit_retries, 7)
  const kept = agentWaterfallBody({ column_name: 'WF', add_to_column: true }, storedWf, wfRecalled, { rowIndexes: null, generation: null })
  assert.ok('ok' in kept && kept.ok.rateLimitRetries === 7)
  const overridden = agentWaterfallBody({ column_name: 'WF', add_to_column: true, rate_limit_retries: 0 }, storedWf, wfRecalled, { rowIndexes: null, generation: null })
  assert.ok('ok' in overridden && overridden.ok.rateLimitRetries === 0)
})

const VERIFY_TOOL = {
  id: 'treg.people.email.verify', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
  inputs: [{ name: 'email', in: 'body', type: 'string', required: true }],
}

async function runEnrichCase(rateLimitRetries: number | undefined, failsBeforeOk: number): Promise<{ calls: number; cell: string }> {
  db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(sid)
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), sid, uid, 0, JSON.stringify({ Email: 'a@acme.example', Verify: PLACEHOLDER }))
  const runId = uuid()
  const config: EnrichRunConfig = {
    requestConfig: { method: 'POST', url: 'https://treg.to/call/treg.people.email.verify', headers: {}, body: '{"email":"{{Email}}"}' },
    responseMapping: [{ columnName: 'Status', jsonPath: '$.output.status' }],
    previewSize: 5,
    enrichment: {
      v: 1, toolId: VERIFY_TOOL.id, toolName: 'Verify', kind: 'waterfall', preset: null,
      toolSnapshot: VERIFY_TOOL, providerNames: { contactout: 'ContactOut' },
      route: { prefer: [], exclude: [], stopAtFirst: false },
      cleanDomains: true, fresh: false,
      ...(rateLimitRetries !== undefined ? { rateLimitRetries } : {}),
      maxCostPerRowUsd: 0.02, spendLimitUsd: 1, rows: { mode: 'all', test: null, where: [] }, email: null,
    },
  }
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,master_column_name,config,status,total_rows,processed_rows,worker_generation)
    VALUES (?,?,?,?,?,'running',1,0,1)`).run(runId, sid, uid, 'Verify', JSON.stringify(config))
  const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as HTTPRunRow
  sent.length = 0
  failLeft = failsBeforeOk
  await processEnrichmentRun(run, config, 1, null)
  const data = JSON.parse(db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(sid) as string)
  return { calls: sent.length, cell: String(data.Verify ?? '') }
}

await ok('runtime enrichment retries honor 0, 2, 7 and default 5 on 429s', async () => {
  const zero = await runEnrichCase(0, 10)
  assert.equal(zero.calls, 1)
  assert.match(zero.cell, /429/)

  const twoOk = await runEnrichCase(2, 2)
  assert.equal(twoOk.calls, 3)
  assert.match(twoOk.cell, /^✅/)

  const twoFail = await runEnrichCase(2, 10)
  assert.equal(twoFail.calls, 3)
  assert.match(twoFail.cell, /429/)

  const sevenOk = await runEnrichCase(7, 7)
  assert.equal(sevenOk.calls, 8)
  assert.match(sevenOk.cell, /^✅/)

  const defFail = await runEnrichCase(undefined, 20)
  assert.equal(defFail.calls, 6)
  assert.match(defFail.cell, /429/)
})

await ok('waterfall enrichment step honors rateLimitRetries (0 vs 2)', async () => {
  const runWf = async (rateLimitRetries: number, failsBeforeOk: number) => {
    db.prepare('DELETE FROM rows WHERE sheet_id = ?').run(sid)
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(uuid(), sid, uid, 0, JSON.stringify({ Email: 'a@acme.example', WF: PLACEHOLDER }))
    const runId = uuid()
    const findTool = {
      id: 'treg.people.email.find', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
      inputs: [{ name: 'email', in: 'body', type: 'string', required: true }],
    }
    const config: WaterfallRunConfig = {
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
            kind: 'enrichment', toolId: findTool.id, inputs: { email: 'email' },
            providerOrder: [], skipProviders: [], stopAtFirst: false, valuePath: '$.output.email', maxCostUsd: 0.02,
          },
          built: {
            kind: 'enrichment', toolName: 'Find', toolKind: 'waterfall', toolSnapshot: findTool,
            route: { prefer: [], exclude: [], stopAtFirst: false }, providerNames: { contactout: 'ContactOut' },
            capUsd: 0.02, valuePath: '$.output.email', cleanDomains: true,
          },
        }],
        hideStepColumns: true, maxCostPerRowUsd: 0.02, tregCapPerRowUsd: 0.02, spendLimitUsd: 1,
        rows: { mode: 'all', status: 'any', test: null }, fresh: false, rateLimitRetries,
      },
    }
    db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,master_column_name,config,status,total_rows,processed_rows,worker_generation)
      VALUES (?,?,?,?,?,'running',1,0,1)`).run(runId, sid, uid, 'WF', JSON.stringify(config))
    const run = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(runId) as HTTPRunRow
    sent.length = 0
    failLeft = failsBeforeOk
    await processWaterfallRun(run, config, 1, null)
    const data = JSON.parse(db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND row_index = 0').pluck().get(sid) as string)
    return { calls: sent.length, cell: String(data.WF ?? '') }
  }
  const zero = await runWf(0, 10)
  assert.equal(zero.calls, 1)
  assert.match(zero.cell, /429/)

  const twoOk = await runWf(2, 2)
  assert.equal(twoOk.calls, 3)
  assert.equal(twoOk.cell, 'ada@acme.example')
})

if (failures > 0) process.exitCode = 1
else console.log('enrich-rate-limit-retries: all passed')

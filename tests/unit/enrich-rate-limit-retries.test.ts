// Per-run provider rate-limit retries (rate_limit_retries, 0-10, default 5): strict parsing on
// enrichment and waterfall starts (app, REST and MCP), and recall on reruns, waterfall_column describe
// and saved setups. The retry counts at run time: enrich-rate-limit-retries-run.test.ts.
import assert from 'node:assert/strict'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const { runMigrations } = await import('../../server/src/db/migrate')
const { parseEnrichRunInput } = await import('../../server/src/lib/enrich-run-input')
const { agentRunBody, unknownArgument } = await import('../../server/src/lib/enrich-agent-input')
const { parseWaterfallInput } = await import('../../server/src/lib/waterfall/input')
const { agentWaterfallBody } = await import('../../server/src/lib/waterfall/agent-args')
const { recallChoices, rerunInput } = await import('../../server/src/lib/enrich-run-recall')
const { enrichRateLimitRetries } = await import('../../server/src/lib/enrich-run-config')
const { recallInput } = await import('../../server/src/services/waterfall-column')
const { agentSetup } = await import('../../server/src/services/waterfall-agent-view')
const { readStep } = await import('../../server/src/lib/setups/check-shape')
type EnrichRunConfig = import('../../server/src/lib/enrich-run-config').EnrichRunConfig
type WaterfallRunConfig = import('../../server/src/lib/waterfall/config').WaterfallRunConfig
type EnrichTool = import('../../server/src/lib/enrich-tool').EnrichTool

runMigrations()

let failures = 0
async function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); console.log(`  ok - ${name}`) }
  catch (err) { failures++; console.error(`  FAIL - ${name}:`, err) }
}

const sid = 'sheet-1'

const baseEnrich = {
  toolId: 'treg.people.email.verify', preset: null, columnName: 'Verify', continueColumn: false,
  inputs: { email: { column: 'Email' } }, cleanDomains: true, providerOrder: [], skipProviders: [],
  stopAtFirst: false, email: null, outputs: [], rows: { mode: 'all', status: 'any', test: false },
  conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
}

const baseWaterfall = {
  columnName: 'WF', continueColumn: false, resultType: 'email',
  inputs: [{ key: 'email', label: 'Email', source: { column: 'Email' } }],
  steps: [{
    id: 's111111', label: 'Formula', on: true, requires: null, choices: { kind: 'formula', formula: '{{email}}' },
  }],
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
    id: 'treg.people.email.verify', name: 'Verify', description: '', category: 'email',
    capability: 'people.email.verify',
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
    requestConfig: {
      method: 'POST', url: 'https://treg.to/call/treg.people.email.verify', headers: {}, body: '{"email":"{{Email}}"}',
    },
    responseMapping: [{ columnName: 'Status', jsonPath: '$.output.status' }],
    previewSize: 5,
    enrichment: {
      v: 1, toolId: tool.id, toolName: 'Verify', kind: 'waterfall', preset: null,
      toolSnapshot: {
        id: tool.id, method: 'POST', inputs: tool.inputs, identitySets: null, derive: null, queryArrayEncoding: null,
      },
      providerNames: { contactout: 'ContactOut' }, route: { prefer: [], exclude: [], stopAtFirst: false },
      cleanDomains: true, fresh: false, rateLimitRetries: 2, maxCostPerRowUsd: 0.02, spendLimitUsd: 1,
      rows: { mode: 'all', test: null, where: [] }, email: null,
    },
  } as unknown as EnrichRunConfig
  const recalled = recallChoices(storedEnrich, 'Verify')
  assert.equal(recalled.rateLimitRetries, 2)
  const rerun = rerunInput(recalled, { mode: 'all', status: 'failed', test: null, rowIndexes: null })
  assert.equal(rerun.rateLimitRetries, 2)

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
  const targets = { rowIndexes: null, generation: null }
  const kept = agentWaterfallBody({ column_name: 'WF', add_to_column: true }, storedWf, wfRecalled, targets)
  assert.ok('ok' in kept && kept.ok.rateLimitRetries === 7)
  const overridden = agentWaterfallBody(
    { column_name: 'WF', add_to_column: true, rate_limit_retries: 0 }, storedWf, wfRecalled, targets)
  assert.ok('ok' in overridden && overridden.ok.rateLimitRetries === 0)
})

if (failures > 0) process.exitCode = 1
else console.log('enrich-rate-limit-retries: all passed')

// Over 200 lines: one stand-in treg for the name check on find steps, verify checks, templates, enrichments, setups.
// Misspelled provider names in providerOrder/skipProviders (and provider_order/skip_providers)
// are refused with the providers treg's catalog knows, across waterfall find steps, verify checks,
// templates, enrichments and saved setups; a saved waterfall or enrichment with an old provider
// name keeps working and says which name it ignored.
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const port = await new Promise<number>(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port
    s.close(() => resolve(p))
  })
})
const treg = spawn(process.execPath, ['tests/mock-treg/server.mjs', String(port)], { stdio: 'ignore' })
const stopTreg = () => { if (!treg.killed) treg.kill() }
process.on('exit', stopTreg)
const TREG = `http://127.0.0.1:${port}`
for (;;) {
  try { if ((await fetch(`${TREG}/health`)).ok) break } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 50))
}
process.env.TREG_BASE_URL = TREG

const { runMigrations } = await import('../../server/src/db/migrate')
const { checkProviderList, checkStepProviders, knownProviderNames, snakeProviderField } =
  await import('../../server/src/lib/enrich-provider-names')
const { parseWaterfallInput } = await import('../../server/src/lib/waterfall/input')
const { agentWaterfallBody } = await import('../../server/src/lib/waterfall/agent-args')
const { WATERFALL_TEMPLATES } = await import('../../server/src/lib/waterfall/templates')
const { buildEnrichmentStep } = await import('../../server/src/services/waterfall-build-enrich')
const { buildCheck } = await import('../../server/src/services/waterfall-build-check')
const { buildWaterfall } = await import('../../server/src/services/waterfall-build')
const { buildEnrichmentConfig } = await import('../../server/src/services/enrich-run-build')
const { parseEnrichRunInput } = await import('../../server/src/lib/enrich-run-input')
const { enrichmentProvidersProblem } = await import('../../server/src/services/setup-apply-checks')
type EnrichTool = import('../../server/src/lib/enrich-tool').EnrichTool
type WaterfallRunConfig = import('../../server/src/lib/waterfall/config').WaterfallRunConfig
type SetupSpec = import('../../server/src/lib/setups/spec').SetupSpec
runMigrations()

let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try {
    await fn(); console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const FIND = 'treg.people.email.find'
const SINGLE = 'hunter.people.email.find'
const VERIFY = 'treg.people.email.verify'
const baseCtx = {
  userId: 'u-prov', sheetId: 's-prov', columns: ['Name', 'Website'],
  sample: [{ Name: 'Maya Chen', Website: 'stripe.com' }], rowsUpperBound: 5,
}
const wfInputs = [
  { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
  { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
]
const findChoices = (over: Record<string, unknown> = {}) => ({
  kind: 'enrichment' as const, toolId: FIND, inputs: { full_name: 'full_name', domain: 'domain' },
  providerOrder: [] as string[], skipProviders: [] as string[], stopAtFirst: false, valuePath: null, maxCostUsd: null,
  ...over,
})

await ok('pure: checkProviderList dedupes, checks case-insensitively, refuses single tools and has no em dash', () => {
  const wfTool = {
    id: FIND, kind: 'waterfall', provider: 'treg',
    providers: [{ provider: 'Hunter' }, { provider: 'tomba' }],
  } as unknown as EnrichTool
  const singleTool = { id: SINGLE, kind: 'single', provider: 'hunter', providers: null } as unknown as EnrichTool
  const noPlanTool = { id: FIND, kind: 'waterfall', provider: 'treg', providers: null } as unknown as EnrichTool
  assert.deepEqual(knownProviderNames(wfTool), ['hunter', 'tomba'])
  const bad = checkProviderList({ where: 'Step 1', field: 'skipProviders', given: ['huntr', 'HUNTR'], tools: [wfTool] })
  assert.equal(bad.error, 'Step 1: unknown provider "huntr" in skipProviders. Known providers: hunter, tomba.')
  const badMany = checkProviderList({ field: 'providerOrder', given: ['foo', 'bar'], tools: [wfTool] })
  assert.equal(badMany.error, 'Unknown providers "foo", "bar" in providerOrder. Known providers: hunter, tomba.')
  const single = checkProviderList({ where: 'Step 1', field: 'skipProviders', given: ['hunter'], tools: [singleTool] })
  assert.ok(single.error?.includes('uses hunter only') && !single.error.includes('\u2014'), String(single.error))
  // A tool whose providers the catalog doesn't list right now: a list is refused (a run couldn't apply it).
  assert.equal(checkProviderList({ field: 'skipProviders', given: ['anything'], tools: [noPlanTool] }).error,
    `The providers of ${FIND} aren't listed in treg's catalog right now, so skipProviders can't be applied. `
    + 'Try again, or leave skipProviders out.')
  assert.equal(checkStepProviders({ order: [], skip: [], orderTools: [noPlanTool] }).error, null, 'no list: no refusal')
  // Verified work email: the finder listed, the email checker not. A misspelled finder skip is refused too.
  const verifyNoPlan = { id: VERIFY, kind: 'waterfall', provider: 'treg', providers: null } as unknown as EnrichTool
  const both = checkStepProviders({
    where: 'Step 1', order: [], skip: ['prospeoo'], orderTools: [wfTool], skipTools: [wfTool, verifyNoPlan],
  })
  assert.equal(both.error, `Step 1: the providers of ${VERIFY} aren't listed in treg's catalog right now, so `
    + "skipProviders can't be applied. Try again, or leave skipProviders out.")
  const saved = checkStepProviders({
    where: 'Step 1', order: ['Hunter', 'oldOne', 'OLDONE'], skip: ['oldSkip'],
    orderTools: [wfTool], saved: { order: ['oldone'], skip: ['oldskip'] },
  })
  assert.equal(saved.error, null)
  assert.deepEqual(saved.ignored, [
    'Step 1: ignored unknown provider "oldOne" in providerOrder (no longer in treg\'s catalog).',
    'Step 1: ignored unknown provider "oldSkip" in skipProviders (no longer in treg\'s catalog).',
  ])
  assert.equal(snakeProviderField(bad.error!),
    'Step 1: unknown provider "huntr" in skip_providers. Known providers: hunter, tomba.')
  assert.equal(snakeProviderField(badMany.error!),
    'Unknown providers "foo", "bar" in provider_order. Known providers: hunter, tomba.')
})

await ok('find step: unknown providerOrder and skipProviders are refused with known providers', async () => {
  const keys = ['full_name', 'domain'], mapped = new Set(keys)
  const badOrder = await buildEnrichmentStep('Step 1', findChoices({ providerOrder: ['hunter', 'huntr'] }),
    'email', keys, mapped)
  assert.ok('fail' in badOrder && badOrder.fail === 'bad_request'
    && badOrder.message.includes('"huntr"') && badOrder.message.includes('providerOrder')
    && badOrder.message.includes('Known providers:') && badOrder.message.includes('hunter'), JSON.stringify(badOrder))
  const badSkip = await buildEnrichmentStep('Step 1', findChoices({ skipProviders: ['prospeoo'] }),
    'email', keys, mapped)
  assert.ok('fail' in badSkip && badSkip.fail === 'bad_request'
    && badSkip.message.includes('"prospeoo"') && badSkip.message.includes('skipProviders')
    && badSkip.message.includes('Known providers:') && badSkip.message.includes('prospeo'), JSON.stringify(badSkip))
  const single = await buildEnrichmentStep('Step 1',
    { kind: 'enrichment', toolId: SINGLE, inputs: { full_name: 'full_name', domain: 'domain' },
      providerOrder: ['hunter'], skipProviders: [], stopAtFirst: false, valuePath: null, maxCostUsd: null },
    'email', keys, mapped)
  assert.ok('fail' in single && single.fail === 'bad_request' && single.message.includes('uses hunter only'),
    JSON.stringify(single))
})

await ok('verify check: unknown providerOrder and skipProviders are refused with known verifiers', async () => {
  const badOrder = await buildCheck('Step 1',
    { kind: 'verify', accept: 'safest', providerOrder: ['droplead'] }, 'email', ['full_name'])
  assert.ok('fail' in badOrder && badOrder.fail === 'bad_request'
    && badOrder.message.includes('"droplead"') && badOrder.message.includes('check.providerOrder')
    && badOrder.message.includes('dropleads') && badOrder.message.includes('trykitt'), JSON.stringify(badOrder))
  const badSkip = await buildCheck('Step 1',
    { kind: 'verify', accept: 'safest', skipProviders: ['trykit'] }, 'email', ['full_name'])
  assert.ok('fail' in badSkip && badSkip.fail === 'bad_request'
    && badSkip.message.includes('"trykit"') && badSkip.message.includes('check.skipProviders')
    && badSkip.message.includes('trykitt') && badSkip.message.includes('millionverifier'), JSON.stringify(badSkip))
})

await ok('saved waterfall: old unknown names keep working and are reported; new typos are still refused', async () => {
  const first = parseWaterfallInput({
    columnName: 'Work email', resultType: 'email', inputs: wfInputs,
    steps: [{
      id: 'sfind01', label: 'Find',
      choices: findChoices({ providerOrder: ['hunter'], skipProviders: ['prospeo'] }),
      check: { kind: 'verify', accept: 'safest', providerOrder: ['trykitt'], skipProviders: ['tomba'] },
    }],
  })
  assert.ok('ok' in first, JSON.stringify(first))
  const built = await buildWaterfall(first.ok, baseCtx)
  assert.ok('ok' in built && built.ok.ignoredProviders.length === 0, JSON.stringify(built))
  // Simulate an older saved waterfall whose providers were later removed from treg.
  const prior = structuredClone({
    requestConfig: { method: 'POST', url: '', headers: {}, body: '{}' },
    responseMapping: [], previewSize: 5, waterfall: built.ok.block,
  }) as WaterfallRunConfig
  const st = prior.waterfall.steps[0]
  if (st.choices.kind === 'enrichment') {
    st.choices.providerOrder = ['hunter', 'oldfinder']
    st.choices.skipProviders = ['prospeo', 'retiredskip']
  }
  if (st.check?.choices.kind === 'verify') {
    st.check.choices.providerOrder = ['trykitt', 'oldverifier']
    st.check.choices.skipProviders = ['tomba', 'retiredver']
  }
  const rerunParsed = parseWaterfallInput({
    columnName: 'Work email', continueColumn: true, resultType: 'email', inputs: wfInputs,
    steps: [{ id: 'sfind01', label: 'Find', choices: st.choices, check: st.check?.choices ?? null }],
  })
  assert.ok('ok' in rerunParsed)
  const rebuilt = await buildWaterfall(rerunParsed.ok, { ...baseCtx, prior })
  assert.ok('ok' in rebuilt, JSON.stringify(rebuilt))
  assert.equal(rebuilt.ok.ignoredProviders.length, 4, JSON.stringify(rebuilt.ok.ignoredProviders))
  for (const name of ['oldfinder', 'retiredskip', 'oldverifier', 'retiredver']) {
    assert.ok(rebuilt.ok.ignoredProviders.some(n => n.includes(`"${name}"`)),
      JSON.stringify(rebuilt.ok.ignoredProviders))
  }
  assert.deepEqual(rebuilt.ok.block.ignoredProviders, rebuilt.ok.ignoredProviders)

  // Adding a brand-new misspelled name to the saved step is still refused.
  const typoParsed = parseWaterfallInput({
    columnName: 'Work email', continueColumn: true, resultType: 'email', inputs: wfInputs,
    steps: [{
      id: 'sfind01', label: 'Find',
      choices: findChoices({ providerOrder: ['hunter', 'oldfinder'], skipProviders: ['retiredskip', 'newtypo'] }),
      check: st.check?.choices ?? null,
    }],
  })
  assert.ok('ok' in typoParsed)
  const refused = await buildWaterfall(typoParsed.ok, { ...baseCtx, prior })
  assert.ok('fail' in refused && refused.fail === 'bad_request' && refused.message.includes('"newtypo"'),
    JSON.stringify(refused))

  // Changing the step's tool drops the saved exception for the old tool's provider names.
  const swappedParsed = parseWaterfallInput({
    columnName: 'Work email', continueColumn: true, resultType: 'email', inputs: wfInputs,
    steps: [{
      id: 'sfind01', label: 'Find',
      choices: { ...findChoices({ toolId: 'treg.people.enrich', providerOrder: ['oldfinder'] }),
        valuePath: '$.output.email' },
    }],
  })
  assert.ok('ok' in swappedParsed)
  const swapped = await buildWaterfall(swappedParsed.ok, { ...baseCtx, prior })
  assert.ok('fail' in swapped && swapped.fail === 'bad_request' && swapped.message.includes('"oldfinder"'),
    JSON.stringify(swapped))
})

await ok('templates: built-in templates build cleanly; template + unknown provider in steps is refused', async () => {
  for (const tpl of WATERFALL_TEMPLATES) {
    const body = agentWaterfallBody(
      { column_name: tpl.title, template: tpl.id, inputs: { full_name: 'Name', domain: 'Website' } },
      null, null, { rowIndexes: null, generation: null },
    )
    assert.ok('ok' in body, JSON.stringify(body))
    const parsed = parseWaterfallInput(body.ok)
    assert.ok('ok' in parsed, JSON.stringify(parsed))
    const built = await buildWaterfall(parsed.ok, baseCtx)
    assert.ok('ok' in built && built.ok.ignoredProviders.length === 0, JSON.stringify(built))
  }
  const withBadStep = agentWaterfallBody({
    column_name: 'Work email', template: 'work_email', inputs: { full_name: 'Name', domain: 'Website' },
    steps: [{ kind: 'enrichment', tool_id: FIND, skip_providers: ['huntr'] }],
  }, null, null, { rowIndexes: null, generation: null })
  assert.ok('ok' in withBadStep)
  const parsedBad = parseWaterfallInput(withBadStep.ok)
  assert.ok('ok' in parsedBad)
  const refused = await buildWaterfall(parsedBad.ok, baseCtx)
  assert.ok('fail' in refused && refused.fail === 'bad_request'
    && snakeProviderField(refused.message).includes('skip_providers') && refused.message.includes('"huntr"'),
    JSON.stringify(refused))
})

await ok('enrichment and verified_email preset: unknown names refused; saved names ignored with note', async () => {
  const mk = (over: Record<string, unknown>) => {
    const p = parseEnrichRunInput({
      toolId: FIND, preset: 'verified_email', columnName: 'Work email', continueColumn: false,
      inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
      providerOrder: [], skipProviders: [], stopAtFirst: false,
      email: { accept: 'safest', guess: false, pattern: 'first.last' },
      outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
      rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
      ...over,
    })
    assert.ok('ok' in p, JSON.stringify(p))
    return p.ok
  }
  // Verify-only provider is valid in skipProviders, refused in providerOrder (order is for finds).
  const okSkip = await buildEnrichmentConfig(mk({ skipProviders: ['millionverifier'] }), ['Name', 'Website'], 5)
  assert.ok('ok' in okSkip, JSON.stringify(okSkip))
  const badOrder = await buildEnrichmentConfig(mk({ providerOrder: ['millionverifier'] }), ['Name', 'Website'], 5)
  assert.ok('fail' in badOrder && badOrder.fail === 'bad_request' && badOrder.message.includes('"millionverifier"'),
    JSON.stringify(badOrder))
  const badSkip = await buildEnrichmentConfig(mk({ skipProviders: ['nosuchprov'] }), ['Name', 'Website'], 5)
  assert.ok('fail' in badSkip && badSkip.fail === 'bad_request' && badSkip.message.includes('"nosuchprov"')
    && badSkip.message.includes('millionverifier') && badSkip.message.includes('hunter'), JSON.stringify(badSkip))
  // Saved enrichment keeps working and reports the ignored name.
  const kept = await buildEnrichmentConfig(mk({ providerOrder: ['hunter', 'oldone'], skipProviders: ['oldskip'] }),
    ['Name', 'Website'], 5, { order: ['oldone'], skip: ['oldskip'] })
  assert.ok('ok' in kept && kept.ignored?.length === 2, JSON.stringify(kept))
})

await ok('saved setups: unknown provider refused for new steps, skipped for carried-on columns', async () => {
  const spec: SetupSpec = {
    v: 1, inputs: ['Name', 'Website'], keys: [],
    steps: [{
      kind: 'enrichment', name: 'Work email', toolId: FIND, toolName: 'Find email', preset: null,
      inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
      providerOrder: [], skipProviders: ['huntr'], stopAtFirst: false, email: null,
      outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
      conditions: [], runIf: null, maxCostPerRowUsd: null, concurrency: null, fresh: false, autoRun: null,
    }],
  }
  const refused = await enrichmentProvidersProblem(spec, ['new'])
  assert.ok(refused && refused.fail === 'bad_request' && refused.message.includes('"huntr"')
    && refused.message.includes('Known providers:'), JSON.stringify(refused))
  assert.equal(await enrichmentProvidersProblem(spec, ['again']), null)
})

stopTreg()
if (failures) { console.error(`${failures} provider name check(s) failed`); process.exitCode = 1 }
else console.log('All provider name assertions passed.')

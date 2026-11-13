// Which providers treg's email verify asks, picked as a find step picks them, against the repo's mock treg (its
// captured catalog): a waterfall step's verify check takes providerOrder and skipProviders (REST) or
// provider_order and skip_providers (MCP and /api/v1), refuses a bad shape in a find step's words, and is built
// with that route and a cap priced on the providers left; a check saved without them reads and builds as before.
// The verified email preset keeps its run's skipped providers out of its checks too (its order is for its finds),
// prices them on the checkers left, keeps verify-only skips on a recalled run, and refuses a run whose skips leave
// no checker. Describe hands the lists back in waterfall_column's names.
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
process.on('exit', () => treg.kill())
const TREG = `http://127.0.0.1:${port}`
for (;;) {
  try { if ((await fetch(`${TREG}/health`)).ok) break } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 50))
}
// treg's address is read when the server's modules load.
process.env.TREG_BASE_URL = TREG

const { runMigrations } = await import('../../server/src/db/migrate')
const { parseCheck } = await import('../../server/src/lib/waterfall/input-check')
const { parseWaterfallInput } = await import('../../server/src/lib/waterfall/input')
const { agentWaterfallBody } = await import('../../server/src/lib/waterfall/agent-args')
const { buildCheck } = await import('../../server/src/services/waterfall-build-check')
const { agentSetup } = await import('../../server/src/services/waterfall-agent-view')
const { buildEnrichmentConfig } = await import('../../server/src/services/enrich-run-build')
const { parseEnrichRunInput } = await import('../../server/src/lib/enrich-run-input')
const { recallChoices } = await import('../../server/src/lib/enrich-run-recall')
const { estimateEnrichment } = await import('../../server/src/services/enrich-setup')
type BuiltVerify = import('../../server/src/lib/waterfall/config').BuiltVerifyCheck
type Setup = import('../../server/src/services/waterfall-column').WaterfallSetup
runMigrations()

let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try {
    await fn(); console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const VERIFIERS = ['contactout', 'trykitt', 'millionverifier', 'dropleads', 'bounceban', 'limadata', 'leadmagic',
  'scrubby', 'tomba', 'hunter', 'zerobounce']
const verify = async (over: Record<string, unknown> = {}): Promise<BuiltVerify> => {
  const r = await buildCheck('Step 2', { kind: 'verify', accept: 'safest', ...over }, 'email', ['email'])
  assert.ok('ok' in r && r.ok, JSON.stringify(r))
  return r.ok.built as BuiltVerify
}

await ok('parse: a verify check takes providerOrder and skipProviders; without them it reads as before', () => {
  assert.deepEqual(parseCheck({ kind: 'verify', accept: 'balanced', providerOrder: ['dropleads'],
    skipProviders: ['trykitt', 'millionverifier'] }, 'Step 2'), { ok: { kind: 'verify', accept: 'balanced',
    providerOrder: ['dropleads'], skipProviders: ['trykitt', 'millionverifier'] } })
  assert.deepEqual(parseCheck({ kind: 'verify' }, 'Step 2'), { ok: { kind: 'verify', accept: 'safest' } })
  assert.deepEqual(parseCheck({ kind: 'verify', providerOrder: [], skipProviders: null }, 'Step 2'),
    { ok: { kind: 'verify', accept: 'safest' } })
})

await ok("parse: a bad list is refused in a find step's words; a stray key too", () => {
  const find = parseWaterfallInput({ columnName: 'Email', resultType: 'email', inputs: [], steps: [
    { choices: { kind: 'enrichment', toolId: 'treg.people.email.find', skipProviders: ['bad name!'] } }] })
  assert.ok('error' in find && find.error.endsWith('skipProviders must be a list of names.'), JSON.stringify(find))
  assert.deepEqual(parseCheck({ kind: 'verify', skipProviders: ['bad name!'] }, 'Step 2'),
    { error: 'Step 2: check.skipProviders must be a list of names.' })
  assert.deepEqual(parseCheck({ kind: 'verify', providerOrder: 'hunter' }, 'Step 2'),
    { error: 'Step 2: check.providerOrder must be a list of names.' })
  const stray = parseCheck({ kind: 'verify', skip: ['hunter'] }, 'Step 2')
  assert.ok('error' in stray && stray.error.includes('skip'), JSON.stringify(stray))
})

await ok('MCP and /api/v1: provider_order and skip_providers on a verify check; the app\'s names refused', () => {
  const target = { rowIndexes: null, generation: null }
  const args = (check: unknown) => ({ sheet_id: 's', column_name: 'Email', result_type: 'email',
    inputs: { full_name: 'Name', domain: 'Website' },
    steps: [{ kind: 'enrichment', tool_id: 'treg.people.email.find', check }] })
  const r = agentWaterfallBody(args({ kind: 'verify', accept: 'wide', provider_order: ['dropleads'],
    skip_providers: ['trykitt'] }), null, null, target)
  assert.ok('ok' in r, JSON.stringify(r))
  const parsed = parseWaterfallInput(JSON.parse(JSON.stringify(r.ok)))
  assert.ok('ok' in parsed, JSON.stringify(parsed))
  assert.deepEqual(parsed.ok.steps[0].check, { kind: 'verify', accept: 'wide', providerOrder: ['dropleads'],
    skipProviders: ['trykitt'] })
  const camel = agentWaterfallBody(args({ kind: 'verify', skipProviders: ['trykitt'] }), null, null, target)
  assert.ok('error' in camel && camel.error.includes('skipProviders'), JSON.stringify(camel))
  const formula = agentWaterfallBody(args({ kind: 'formula', formula: '{{value}}' }), null, null, target)
  assert.ok('ok' in formula, JSON.stringify(formula))
})

await ok('build: the check asks in its order and never a skipped provider; an unknown name does nothing', async () => {
  const plain = await verify()
  assert.deepEqual(plain.prefer, [])
  assert.deepEqual(plain.exclude, [])
  const picked = await verify({ providerOrder: ['Dropleads', 'hunter', 'nosuchverifier'],
    skipProviders: ['trykitt', 'MillionVerifier', 'nosuchverifier'] })
  assert.deepEqual(picked.prefer, ['dropleads', 'hunter'])
  assert.deepEqual(picked.exclude, ['millionverifier', 'trykitt'])
  // A skipped provider is never preferred, whatever the order says.
  assert.deepEqual((await verify({ providerOrder: ['trykitt', 'tomba'], skipProviders: ['trykitt'] })).prefer,
    ['tomba'])
})

await ok('build: the cap is priced on the providers left', async () => {
  const all = (await verify()).capUsd!
  const cheaper = (await verify({ skipProviders: ['zerobounce', 'hunter'] })).capUsd!
  assert.ok(all > 0 && cheaper > 0 && cheaper < all, JSON.stringify({ all, cheaper }))
})

await ok('build: skips that leave no provider are refused before anything runs', async () => {
  const r = await buildCheck('Step 2', { kind: 'verify', accept: 'safest', skipProviders: VERIFIERS }, 'email', [])
  assert.deepEqual(r, { fail: 'bad_request',
    message: 'Step 2: no provider can verify the email with these switches. Switch providers on.' })
})

await ok('describe: the lists in waterfall_column\'s names, only when the check has them', () => {
  const setup = (check: unknown) => ({
    input: { columnName: 'Email', resultType: 'email', inputs: [], answeredBy: true, hideStepColumns: true,
      runIf: null, fresh: false, steps: [{ id: 'sabc123', label: 'Find', on: true, requires: null, check,
        choices: { kind: 'formula', formula: '"a@b.co"' } }] },
    columns: { answeredBy: null, steps: {} }, activeRunId: null, autoRun: false, toolNames: {}, sheetNames: {},
  }) as unknown as Setup
  const steps = (check: unknown) => (agentSetup(setup(check), { secrets: false }).steps as any[])[0].check
  assert.deepEqual(steps({ kind: 'verify', accept: 'safest', providerOrder: ['dropleads'], skipProviders: ['hunter'] }),
    { kind: 'verify', accept: 'safest', provider_order: ['dropleads'], skip_providers: ['hunter'] })
  assert.deepEqual(steps({ kind: 'verify', accept: 'safest' }), { kind: 'verify', accept: 'safest' })
})

const presetBody = (over: Record<string, unknown> = {}) => ({
  toolId: 'treg.people.email.find', preset: 'verified_email', columnName: 'Work email', continueColumn: false,
  inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
  providerOrder: ['hunter'], skipProviders: [], stopAtFirst: false,
  email: { accept: 'safest', guess: false, pattern: 'first.last' },
  outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' },
    { key: 'email_status', path: null, columnName: 'Email status' }],
  rows: { mode: 'all', test: false }, conditions: [], maxCostPerRowUsd: null, spendLimitUsd: null, fresh: false,
  ...over,
})
const preset = async (over: Record<string, unknown> = {}) => {
  const input = parseEnrichRunInput(presetBody(over))
  assert.ok('ok' in input, JSON.stringify(input))
  return buildEnrichmentConfig(input.ok, ['Name', 'Website'], 10)
}

await ok("preset: the run's skips keep those providers out of its checks; its order is for the finds", async () => {
  const plain = await preset()
  assert.ok('ok' in plain, JSON.stringify(plain))
  assert.deepEqual(plain.ok.enrichment.email!.verifyExclude, [])
  const skipped = await preset({ skipProviders: ['quickenrich', 'trykitt', 'millionverifier'] })
  assert.ok('ok' in skipped, JSON.stringify(skipped))
  const e = skipped.ok.enrichment
  assert.deepEqual(e.email!.verifyExclude, ['millionverifier', 'trykitt'])
  assert.ok(e.route.exclude.includes('quickenrich') && e.route.exclude.includes('trykitt'), JSON.stringify(e.route))
  assert.ok(!e.route.exclude.includes('millionverifier'), 'a checker only is no finder to skip')
  assert.deepEqual(e.route.prefer, ['hunter'])
  // A rerun from the column keeps the skip that only checks.
  const recalled = recallChoices({ ...skipped.ok }, 'Work email')
  assert.ok(recalled.skipProviders.includes('millionverifier') && recalled.skipProviders.includes('quickenrich'),
    JSON.stringify(recalled.skipProviders))
})

await ok('preset: checks priced on the checkers left; skips that leave none are refused', async () => {
  const est = async (skip: string[]) => {
    const r = await estimateEnrichment('u-verify', { toolId: 'treg.people.email.find', rows: 10,
      preset: 'verified_email', given: ['full_name', 'domain'], skip, order: [], stopAtFirst: false,
      maxCostPerRowUsd: null, limit: null, list: null })
    assert.ok('ok' in r, JSON.stringify(r))
    return r.ok.defaultMaxCostPerRowUsd
  }
  const all = await est([]), fewer = await est(['zerobounce', 'hunter'])
  assert.ok(fewer < all, JSON.stringify({ all, fewer }))
  const built = await preset({ skipProviders: ['zerobounce', 'hunter'] })
  const full = await preset()
  const capOf = (r: typeof built) => ('ok' in r ? r.ok.enrichment.maxCostPerRowUsd : null)
  assert.ok(capOf(built)! < capOf(full)!,
    JSON.stringify([capOf(full), capOf(built)]))
  assert.deepEqual(await preset({ skipProviders: VERIFIERS }), { fail: 'bad_request',
    message: 'No provider can verify the email with these switches. Switch providers on.' })
})

treg.kill()
if (failures) { console.error(`${failures} waterfall verify provider check(s) failed`); process.exit(1) }
console.log('All waterfall verify provider assertions passed.')
process.exit(0)

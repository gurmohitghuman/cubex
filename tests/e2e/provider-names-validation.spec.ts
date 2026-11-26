// Over 200 lines: every surface that takes provider names (app routes, /api/v1, MCP, setups, templates), one sheet.
import { test, expect, APIRequestContext } from '@playwright/test'
import Database from 'better-sqlite3'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { assertTestDb, authedApi, makeAccessToken } from './helpers'
import { mockTreg } from './helpers-treg'
import { callEveryRow, freshTreg, rowsOf, seedCsv, verifiedEmailRun } from './helpers-enrich'
import { call, mcpClient } from './helpers-mcp'

// A misspelled provider name in providerOrder/skipProviders (provider_order/skip_providers)
// is refused with the list of providers treg's catalog knows, across find steps, verify checks,
// templates, enrichments and saved setups, over REST and MCP. An old saved waterfall whose
// stored setup holds a provider name no longer in the catalog keeps working and notes which
// name it ignored.
const FIND = 'treg.people.email.find'
const GUESS = "{{full_name}}.toLowerCase().replace(' ', '.') + '@' + {{domain}}"
const CSV = 'Name,Website\nMaya Chen,stripe.com\nLeo Martins,notion.so\nAva Patel,figma.com'
const wfInputs = [
  { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
  { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
]
let api: APIRequestContext
let mcp: Client
let token: string

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => {
  api = await authedApi()
  token = await makeAccessToken(api, ['read', 'write', 'run'], 'provider names spec')
  mcp = await mcpClient(token)
})
test.afterAll(async () => { await mcp?.close(); await api?.dispose() })

const auth = () => ({ Authorization: `Bearer ${token}` })

async function mcpError(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await mcp.callTool({ name, arguments: args }) as { isError?: boolean; content?: Array<{ text?: string }> }
  expect(r.isError, JSON.stringify(r)).toBeTruthy()
  const text = r.content?.map(c => c.text ?? '').join(' ') ?? ''
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.error === 'string') return parsed.error
  } catch { /* raw */ }
  return text
}

test('REST (/api/waterfall, /api/enrich and /api/v1): unknown provider names refused with known list', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const appWf = async (path: string, step: Record<string, unknown>) => {
    const res = await api.post(`/api/waterfall/sheets/${sheetId}/${path}`, {
      data: { columnName: 'Work email', resultType: 'email', inputs: wfInputs, steps: [{ label: 'Step', ...step }] },
    })
    expect(res.status(), path).toBe(400)
    return (await res.json()).error as string
  }
  const findStep = (over: Record<string, unknown>) => ({
    choices: { kind: 'enrichment', toolId: FIND, inputs: { full_name: 'full_name', domain: 'domain' }, ...over },
  })
  const verifyStep = (over: Record<string, unknown>) => ({
    choices: { kind: 'formula', formula: GUESS }, check: { kind: 'verify', accept: 'safest', ...over },
  })

  for (const path of ['estimate', 'runs']) {
    const e1 = await appWf(path, findStep({ providerOrder: ['huntr'] }))
    expect(e1).toContain('"huntr"')
    expect(e1).toContain('providerOrder')
    expect(e1).toContain('hunter')
    const e2 = await appWf(path, findStep({ skipProviders: ['prospeoo'] }))
    expect(e2).toContain('"prospeoo"')
    expect(e2).toContain('skipProviders')
    expect(e2).toContain('prospeo')
    const e3 = await appWf(path, verifyStep({ providerOrder: ['droplead'] }))
    expect(e3).toContain('"droplead"')
    expect(e3).toContain('check.providerOrder')
    expect(e3).toContain('dropleads')
    const e4 = await appWf(path, verifyStep({ skipProviders: ['trykit'] }))
    expect(e4).toContain('"trykit"')
    expect(e4).toContain('check.skipProviders')
    expect(e4).toContain('trykitt')
  }

  // /api/v1 waterfall (both estimate_only true and false, and with template + steps).
  const v1Wf = async (body: Record<string, unknown>) => {
    const res = await api.post(`/api/v1/sheets/${sheetId}/waterfall-columns`, { headers: auth(), data: body })
    expect(res.status()).toBe(400)
    return (await res.json()).error as string
  }
  const v1Base = { column_name: 'Work email', result_type: 'email', inputs: { full_name: 'Name', domain: 'Website' } }
  expect(await v1Wf({ ...v1Base, steps: [{ kind: 'enrichment', tool_id: FIND, provider_order: ['huntr'] }] }))
    .toMatch(/unknown provider "huntr" in provider_order.*hunter/i)
  expect(await v1Wf({ ...v1Base, steps: [{ kind: 'enrichment', tool_id: FIND, skip_providers: ['prospeoo'] }] }))
    .toMatch(/unknown provider "prospeoo" in skip_providers.*prospeo/i)
  expect(await v1Wf({ ...v1Base, estimate_only: true,
    steps: [{ kind: 'formula', formula: GUESS, check: { kind: 'verify', provider_order: ['droplead'] } }] }))
    .toMatch(/unknown provider "droplead" in check\.provider_order.*dropleads/i)
  expect(await v1Wf({ ...v1Base, template: 'work_email',
    steps: [{ kind: 'formula', formula: GUESS, check: { kind: 'verify', skip_providers: ['trykit'] } }] }))
    .toMatch(/unknown provider "trykit" in check\.skip_providers.*trykitt/i)

  // Standalone enrichment REST (/api/enrich and /api/v1).
  const appEnrich = await api.post(`/api/enrich/sheets/${sheetId}/runs`,
    { data: verifiedEmailRun({ skipProviders: ['nosuchprov'] }) })
  expect(appEnrich.status()).toBe(400)
  expect((await appEnrich.json()).error).toMatch(/unknown provider "nosuchprov" in skipProviders.*millionverifier/i)
  const v1Enrich = await api.post(`/api/v1/sheets/${sheetId}/enrichment-runs`, {
    headers: auth(),
    data: {
      tool_id: FIND, preset: 'verified_email', column_name: 'Work email',
      inputs: { full_name: 'Name', domain: 'Website' }, provider_order: ['millionverifier'],
    },
  })
  expect(v1Enrich.status()).toBe(400)
  expect((await v1Enrich.json()).error).toMatch(/unknown provider "millionverifier" in provider_order.*hunter/i)
  // Refused before any paid call was made.
  expect(await mockTreg.providers()).toEqual([])
})

test('MCP: waterfall_column, templates, run_enrichment and apply_setup refuse unknown provider names', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const wfArgs = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
    sheet_id: sheetId, column_name: 'Work email', result_type: 'email',
    inputs: { full_name: 'Name', domain: 'Website' }, steps, ...extra,
  })
  expect(await mcpError('waterfall_column', wfArgs([{ kind: 'enrichment', tool_id: FIND, provider_order: ['huntr'] }])))
    .toMatch(/unknown provider "huntr" in provider_order.*hunter/i)
  expect(await mcpError('waterfall_column',
    wfArgs([{ kind: 'enrichment', tool_id: FIND, skip_providers: ['prospeoo'] }])))
    .toMatch(/unknown provider "prospeoo" in skip_providers.*prospeo/i)
  expect(await mcpError('waterfall_column',
    wfArgs([{ kind: 'formula', formula: GUESS, check: { kind: 'verify', provider_order: ['droplead'] } }])))
    .toMatch(/unknown provider "droplead" in check\.provider_order.*dropleads/i)
  expect(await mcpError('waterfall_column',
    wfArgs([{ kind: 'formula', formula: GUESS, check: { kind: 'verify', skip_providers: ['trykit'] } }])))
    .toMatch(/unknown provider "trykit" in check\.skip_providers.*trykitt/i)
  expect(await mcpError('waterfall_column',
    wfArgs([{ kind: 'enrichment', tool_id: FIND, skip_providers: ['huntr'] }], { template: 'work_email' })))
    .toMatch(/unknown provider "huntr" in skip_providers.*hunter/i)

  expect(await mcpError('run_enrichment', {
    sheet_id: sheetId, tool_id: FIND, preset: 'verified_email', column_name: 'Work email',
    inputs: { full_name: 'Name', domain: 'Website' }, provider_order: ['huntr'], estimate_only: true,
  })).toMatch(/unknown provider "huntr" in provider_order.*hunter/i)
  expect(await mcpError('run_enrichment', {
    sheet_id: sheetId, tool_id: FIND, preset: 'verified_email', column_name: 'Work email',
    inputs: { full_name: 'Name', domain: 'Website' }, skip_providers: ['trykit'], estimate_only: true,
  })).toMatch(/unknown provider "trykit" in skip_providers.*trykitt/i)

  // Imported setup template with a misspelled provider is refused by apply_setup.
  const imported = await api.post('/api/setups/import', {
    data: {
      format: 'cubex-setup', version: 1, name: 'Bad provider setup', description: null,
      spec: {
        v: 1, inputs: ['Name', 'Website'], keys: [],
        steps: [{
          kind: 'enrichment', name: 'Work email', toolId: FIND, toolName: 'Email', preset: null,
          inputs: { full_name: { column: 'Name' }, domain: { column: 'Website' } }, cleanDomains: true,
          providerOrder: [], skipProviders: ['huntr'], stopAtFirst: false, email: null,
          outputs: [{ key: 'email', path: '$.output.email', columnName: 'Email' }],
          conditions: [], runIf: null, maxCostPerRowUsd: null, concurrency: null, fresh: false, autoRun: null,
        }],
      },
    },
  })
  const setup = await imported.json()
  expect(imported.status(), JSON.stringify(setup)).toBe(201)
  expect(await mcpError('apply_setup', { sheet_id: sheetId, setup_id: setup.id, estimate_only: true }))
    .toMatch(/unknown provider "huntr" in skipProviders.*hunter/i)
  expect(await mockTreg.providers()).toEqual([])
})

test('an old saved waterfall with retired provider names keeps working over REST and MCP and names what it ignored',
  async () => {
    await freshTreg(api)
    const { sheetId } = await seedCsv(api, CSV)
    const seedRes = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, {
      data: {
        columnName: 'Work email', resultType: 'email', inputs: wfInputs, fresh: true,
        rows: { mode: 'all', test: 1 },
        steps: [
          {
            id: 'sfind11', label: 'Find',
            choices: { kind: 'enrichment', toolId: FIND, inputs: { full_name: 'full_name', domain: 'domain' },
              providerOrder: ['hunter'], skipProviders: ['prospeo'] },
          },
          {
            id: 'sverf22', label: 'Guess', choices: { kind: 'formula', formula: GUESS },
            check: { kind: 'verify', accept: 'safest', providerOrder: ['trykitt'], skipProviders: ['tomba'] },
          },
        ],
      },
    })
    const seeded = await seedRes.json()
    expect(seedRes.ok(), JSON.stringify(seeded)).toBeTruthy()
    await expect.poll(async () => (await (await api.get(`/api/waterfall/runs/${seeded.runId}`)).json()).status,
      { timeout: 30_000 }).toBe('completed')

    // Patch the stored run config to hold old provider names no longer in treg's catalog.
    const db = new Database(assertTestDb(process.env.DB_PATH))
    try {
      const raw = db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(seeded.runId) as string
      const cfg = JSON.parse(raw)
      cfg.waterfall.steps[0].choices.providerOrder = ['hunter', 'oldfinder']
      cfg.waterfall.steps[0].choices.skipProviders = ['prospeo', 'retiredskip']
      cfg.waterfall.steps[1].check.choices.providerOrder = ['trykitt', 'oldverifier']
      cfg.waterfall.steps[1].check.choices.skipProviders = ['tomba', 'retiredver']
      db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(JSON.stringify(cfg), seeded.runId)
    } finally { db.close() }

    // MCP estimate on the saved waterfall keeps working and lists every ignored name.
    const est = await call(mcp, 'waterfall_column', {
      sheet_id: sheetId, column_name: 'Work email', add_to_column: true, rows: 'not_enriched',
    })
    expect(est.estimate_only).toBe(true)
    const estNotes = (est.notes as string[]).join('\n')
    for (const name of ['oldfinder', 'retiredskip', 'oldverifier', 'retiredver']) {
      expect(estNotes).toContain(`"${name}"`)
    }
    expect(estNotes).toContain('provider_order')
    expect(estNotes).toContain('skip_providers')

    // Adding a brand-new misspelled name to the saved waterfall is still refused.
    const setup = await call(mcp, 'waterfall_column', {
      action: 'describe', sheet_id: sheetId, column_name: 'Work email',
    })
    const cleanStep = (s: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null))
    const steps = (setup.steps as Record<string, unknown>[]).map(cleanStep)
    const badSteps = structuredClone(steps)
    ;(badSteps[0].skip_providers as string[]).push('brandnewtypo')
    expect(await mcpError('waterfall_column', {
      sheet_id: sheetId, column_name: 'Work email', add_to_column: true, steps: badSteps, rows: 'not_enriched',
    })).toMatch(/unknown provider "brandnewtypo" in skip_providers/i)

    // REST rerun estimate and start keep working and report the ignored names.
    const rerunEstRes = await api.post(`/api/waterfall/sheets/${sheetId}/reruns`, {
      data: { column: 'Work email', status: 'not_enriched', estimateOnly: true },
    })
    expect(rerunEstRes.ok()).toBeTruthy()
    const rerunEstNotes = ((await rerunEstRes.json()).estimate.notes as string[]).join('\n')
    expect(rerunEstNotes).toContain('"oldfinder"')
    expect(rerunEstNotes).toContain('"retiredver"')

    // MCP start on the saved waterfall runs remaining rows and reports the ignored names.
    const started = await call(mcp, 'waterfall_column', {
      sheet_id: sheetId, column_name: 'Work email', add_to_column: true, steps,
      rows: 'not_enriched', estimate_only: false,
    })
    const startNotes = (started.notes as string[]).join('\n')
    expect(startNotes).toContain('"oldfinder"')
    expect(startNotes).toContain('"retiredver"')
    await expect.poll(async () => (await call(mcp, 'get_run',
      { action: 'status', run_type: 'waterfall', run_id: started.run_id, wait_seconds: 2 })).status,
    { timeout: 30_000 }).toBe('completed')
    const status = await call(mcp, 'get_run', { action: 'status', run_type: 'waterfall', run_id: started.run_id })
    expect((status.waterfall.notes as string[]).join('\n')).toContain('"oldfinder"')

    // Every row is now filled, and control_run rerun on the saved waterfall keeps working with notes too.
    expect((await rowsOf(api, sheetId)).map(r => r['Work email']))
      .toEqual(['maya@stripe.com', 'leo@notion.so', 'ava@figma.com'])
    const rerun = await call(mcp, 'control_run',
      { run_type: 'waterfall', run_id: started.run_id, action: 'rerun', mode: 'all' })
    expect((rerun.notes as string[]).join('\n')).toContain('"oldfinder"')
    expect((rerun.notes as string[]).join('\n')).toContain('"retiredver"')
    await expect.poll(async () => (await call(mcp, 'get_run',
      { action: 'status', run_type: 'waterfall', run_id: rerun.run_id, wait_seconds: 2 })).status,
    { timeout: 30_000 }).toBe('completed')
  })

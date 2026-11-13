import { test, expect, APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, makeAccessToken } from './helpers'
import { mockTreg } from './helpers-treg'
import { callEveryRow, freshTreg, rowsOf, seedCsv, startRun, verifiedEmailRun, waitRun } from './helpers-enrich'
import { call, mcpClient, waitMcpRun } from './helpers-mcp'

// treg's email verify, as a waterfall step's check, asks its providers as a find step does: those in the check's
// order first, never one it skips (the stand-in logs every provider it asks), over REST and MCP. A check without
// the lists asks every provider in treg's order, as before. The verified email preset's skipped providers are
// kept out of its checks too; its order is for its finds.
const VERIFY = 'treg.people.email.verify'
const SKIP = ['trykitt', 'millionverifier']
const GUESS = "{{full_name}}.toLowerCase().replace(' ', '.') + '@' + {{domain}}"
const CSV = 'Name,Website\nMaya Chen,stripe.com\nLeo Martins,notion.so'
const inputs = [
  { key: 'full_name', label: 'Full name', source: { column: 'Name' } },
  { key: 'domain', label: 'Company domain', source: { column: 'Website' } },
]
const body = (check: Record<string, unknown>) => ({
  columnName: 'Work email', resultType: 'email', inputs, fresh: true,
  steps: [{ id: 'sguessv', label: 'Guess', choices: { kind: 'formula', formula: GUESS }, check }],
})
let api: APIRequestContext
let mcp: Client

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => {
  api = await authedApi()
  mcp = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'verify providers spec'))
})
test.afterAll(async () => { await mcp?.close(); await api?.dispose() })

const asked = async (toolId = VERIFY) =>
  (await mockTreg.providers()).filter(p => p.toolId === toolId).map(p => p.provider)
const calls = async (toolId = VERIFY) => (await mockTreg.requests()).filter(r => r.path === `/call/${toolId}`)
const header = (h: Record<string, string | undefined>, name: string) => (h[name] ?? '').split(',').filter(Boolean)

async function runWaterfall(sheetId: string, check: Record<string, unknown>) {
  const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body(check) })
  const run = await res.json()
  expect(res.ok(), JSON.stringify(run)).toBeTruthy()
  await expect.poll(async () => {
    const s = await (await api.get(`/api/waterfall/runs/${run.runId}`)).json()
    return s.status === 'completed' ? s.status : `${s.status}: ${s.message ?? ''}`
  }, { timeout: 30_000 }).toBe('completed')
}
const checkOf = async (sheetId: string) =>
  (await (await api.get(`/api/waterfall/sheets/${sheetId}/column-setup?column=Work%20email`)).json())
    .input.steps[0].check

test('REST: an email check asks its own providers in its order, never a skipped one', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const check = { kind: 'verify', accept: 'safest', providerOrder: ['dropleads'], skipProviders: SKIP }
  await runWaterfall(sheetId, check)
  expect((await rowsOf(api, sheetId)).map(r => r['Work email']))
    .toEqual(['maya.chen@stripe.com', 'leo.martins@notion.so'])
  // Dropleads first on each row, and it answers: nobody else is asked.
  expect(await asked()).toEqual(['dropleads', 'dropleads'])
  const sent = await calls()
  expect(sent).toHaveLength(2)
  for (const c of sent) {
    expect(header(c.headers, 'x-treg-route-prefer')).toEqual(['dropleads'])
    expect(header(c.headers, 'x-treg-route-exclude')).toEqual(expect.arrayContaining(SKIP))
  }
  expect(await checkOf(sheetId)).toEqual(check)

  // Its skips alone: treg's order, without them.
  await freshTreg(api)
  const { sheetId: s2 } = await seedCsv(api, CSV)
  await runWaterfall(s2, { kind: 'verify', accept: 'safest', skipProviders: SKIP })
  const names = await asked()
  expect(names.length).toBeGreaterThan(0)
  expect(names.filter(n => SKIP.includes(n))).toEqual([])
  expect((await rowsOf(api, s2))[0]['Work email']).toBe('maya.chen@stripe.com')
})

test('REST: a check without the lists asks as before; bad lists are refused in a find step\'s words', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  await runWaterfall(sheetId, { kind: 'verify', accept: 'safest' })
  expect(await asked()).toContain('trykitt')
  for (const c of await calls()) {
    expect(c.headers['x-treg-route-prefer']).toBeUndefined()
    expect(header(c.headers, 'x-treg-route-exclude')).not.toContain('trykitt')
  }
  expect(await checkOf(sheetId)).toEqual({ kind: 'verify', accept: 'safest' })

  const refused = async (check: Record<string, unknown>) => {
    const res = await api.post(`/api/waterfall/sheets/${sheetId}/runs`, { data: body(check) })
    expect(res.status()).toBe(400)
    return (await res.json()).error as string
  }
  expect(await refused({ kind: 'verify', skipProviders: 'trykitt' }))
    .toBe('Step 1: check.skipProviders must be a list of names.')
  expect(await refused({ kind: 'verify', skipProviders: ['contactout', 'trykitt', 'millionverifier', 'dropleads',
    'bounceban', 'limadata', 'leadmagic', 'scrubby', 'tomba', 'hunter', 'zerobounce'] }))
    .toMatch(/no provider can verify the email with these switches/)
})

test('MCP: waterfall_column takes provider_order and skip_providers on a check; describe gives them back', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const check = { kind: 'verify', accept: 'safest', provider_order: ['tomba', 'dropleads'], skip_providers: SKIP }
  const args = { sheet_id: sheetId, column_name: 'Work email', result_type: 'email',
    inputs: { full_name: 'Name', domain: 'Website' },
    steps: [{ kind: 'formula', label: 'Guess', formula: GUESS, check }] }
  const started = await call(mcp, 'waterfall_column', { ...args, estimate_only: false })
  await expect.poll(async () => (await call(mcp, 'get_run_status',
    { run_type: 'waterfall', run_id: started.run_id, wait_seconds: 2 })).status, { timeout: 30_000 }).toBe('completed')
  const names = await asked()
  expect(names[0]).toBe('tomba')
  expect(names.filter(n => SKIP.includes(n))).toEqual([])
  for (const c of await calls()) {
    expect(header(c.headers, 'x-treg-route-prefer')).toEqual(['tomba', 'dropleads'])
    expect(header(c.headers, 'x-treg-route-exclude')).toEqual(expect.arrayContaining(SKIP))
  }
  const setup = await call(mcp, 'waterfall_column',
    { action: 'describe', sheet_id: sheetId, column_name: 'Work email' })
  expect(setup.steps[0].check).toEqual(check)
  // What describe gives goes back in as it is.
  const again = await call(mcp, 'waterfall_column',
    { sheet_id: sheetId, column_name: 'Work email', add_to_column: true, steps: setup.steps, rows: 'any' })
  expect(again.estimate_only).toBe(true)
})

test('the verified email preset keeps skipped providers out of its checks; its order is for its finds', async () => {
  const skip = ['quickenrich', ...SKIP]
  const leads = 'Name,Website\nMaya Chen,https://stripe.com\nLeo Martins,notion.so'
  const check = async () => {
    const names = await asked()
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter(n => skip.includes(n))).toEqual([])
    for (const c of await calls()) {
      expect(c.headers['x-treg-route-prefer']).toBeUndefined()
      expect(header(c.headers, 'x-treg-route-exclude')).toEqual(expect.arrayContaining(SKIP))
    }
  }
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, leads)
  const runId = await startRun(api, sheetId, verifiedEmailRun({ skipProviders: skip, providerOrder: ['hunter'] }))
  await waitRun(api, runId, ['completed'], 30_000)
  await check()
  for (const c of await calls('treg.people.email.find')) {
    expect(header(c.headers, 'x-treg-route-prefer')).toEqual(['hunter'])
    expect(header(c.headers, 'x-treg-route-exclude')).toContain('quickenrich')
  }

  await freshTreg(api)
  const { sheetId: s2 } = await seedCsv(api, leads)
  const r = await call(mcp, 'run_enrichment', {
    sheet_id: s2, tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: 'Work email',
    inputs: { full_name: 'Name', domain: 'Website' }, skip_providers: skip, provider_order: ['hunter'],
  })
  await waitMcpRun(mcp, r.run_id, ['completed'], 30_000)
  await check()
})

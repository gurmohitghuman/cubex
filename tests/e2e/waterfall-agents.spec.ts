// Over 200 lines: the MCP and REST clients are set up once for every agent check here.
import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { bearer, makeToken } from './api-v1-run-helpers'
import { call, callError, mcpClient } from './helpers-mcp'
import { callEveryRow, freshTreg, readDb, rowsOf, seedCsv } from './helpers-enrich'
import { Receiver } from './helpers-receiver'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

// waterfall_column over MCP and /api/v1: an estimate unless asked otherwise,
// strict arguments, a run polled with run_type waterfall (per-step counts) and
// read back with each row's trace, a column's setup described and run again
// with a step switched off, control_run's rerun, the 'secrets' scope for an
// HTTP step reading a saved key, and run webhooks naming the kind.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
let mcp: Client
let mcpSecrets: Client

test.describe.configure({ mode: 'serial' })
callEveryRow()
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  for (const h of (await (await api.get('/api/settings/run-webhooks')).json()).webhooks) {
    await api.delete(`/api/settings/run-webhooks/${h.id}`)
  }
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'waterfall agents spec'))
  mcp = await mcpClient(await makeToken(api, ['read', 'write', 'run'], 'waterfall mcp spec'))
  mcpSecrets = await mcpClient(await makeToken(api, ['read', 'write', 'run', 'secrets'], 'waterfall mcp secrets'))
  rx.on('/find', { status: 200, body: JSON.stringify({ email: 'nobody.here@nobody.example' }) })
  rx.on('/hook', { status: 200, body: '{}' })
})
test.afterAll(async () => {
  await rx.stop(); await v1?.dispose(); await mcp?.close(); await mcpSecrets?.close(); await api?.dispose()
})

const CSV = ['Name,Website', 'Maya Chen,https://stripe.com', 'Nobody Here,nobody.example'].join('\n')

function args(sheetId: string, over: Record<string, unknown> = {}) {
  return {
    sheet_id: sheetId, column_name: 'Work email', result_type: 'email',
    inputs: { full_name: 'Name', domain: 'Website' },
    steps: [
      { kind: 'enrichment', label: 'treg finder', tool_id: 'treg.people.email.find' },
      { kind: 'enrichment', label: 'Hunter', tool_id: 'hunter.people.email.find' },
      { kind: 'http', label: 'Own API', url: rx.url('/find?d={{domain}}'), value_path: '$.email' },
    ],
    ...over,
  }
}

// A schema refusal (an argument the tool doesn't know) comes back as the SDK's text, not JSON.
async function refused(name: string, a: Record<string, unknown>): Promise<string> {
  const res = await mcp.callTool({ name, arguments: a }) as { isError?: boolean; content?: Array<{ text?: string }> }
  expect(res.isError).toBeTruthy()
  return res.content?.map(c => c.text ?? '').join(' ') ?? ''
}

async function waitDone(runId: string) {
  for (let i = 0; i < 60; i++) {
    const s = await call(mcp, 'get_run_status', { run_type: 'waterfall', run_id: runId, wait_seconds: 2 })
    if (['completed', 'failed', 'cancelled'].includes(s.status)) return s
  }
  throw new Error(`run ${runId} didn't finish`)
}

test('MCP: an estimate by default, strict arguments, then a run read back step by step', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const est = await call(mcp, 'waterfall_column', args(sheetId))
  expect(est.estimate_only).toBe(true)
  expect(est.rows).toBe(2)
  expect(est.per_row.max_usd).toBeGreaterThan(0)
  expect((await rowsOf(api, sheetId))[0]['Work email']).toBeUndefined()

  expect(await refused('waterfall_column', args(sheetId, { estimateOnly: false }))).toMatch(/estimateOnly/)
  const badStep = args(sheetId, { steps: [{ kind: 'ai', prompt: 'x /full_name', temperature: 1 }] })
  expect(await refused('waterfall_column', badStep)).toMatch(/temperature/)

  const started = await call(mcp, 'waterfall_column', args(sheetId, { estimate_only: false }))
  expect(started.run_type).toBe('waterfall')
  const s = await waitDone(started.run_id)
  expect(s.status).toBe('completed')
  expect(s.waterfall.steps.map((x: { label: string; answered: number }) => [x.label, x.answered]))
    .toEqual([['treg finder', 1], ['Hunter', 0], ['Own API', 1]])
  expect(s.waterfall.spent.treg_usd).toBeGreaterThanOrEqual(0)

  const res = await call(mcp, 'get_run_results',
    { run_type: 'waterfall', run_id: started.run_id, status_filter: 'all' })
  const byRow = Object.fromEntries(res.results.map((r: { row_index: number }) => [r.row_index, r]))
  expect(byRow[0].answered_by).toBe('treg finder')
  expect(byRow[1].answered_by).toBe('Own API')
  expect(byRow[1].trace.map((t: { outcome: string }) => t.outcome)).toEqual(['not_found', 'not_found', 'answered'])
})

test('MCP: describe, then run again with a step switched off; control_run reruns by mode', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const first = await call(mcp, 'waterfall_column', args(sheetId, { estimate_only: false }))
  await waitDone(first.run_id)
  const setup = await call(mcp, 'waterfall_column',
    { action: 'describe', sheet_id: sheetId, column_name: 'Work email' })
  expect(setup.steps.map((x: { label: string }) => x.label)).toEqual(['treg finder', 'Hunter', 'Own API'])
  expect(setup.step_columns[setup.steps[1].id]).toBe('Work email (Hunter)')

  // Hunter off, every row again: its column stays, and only the other two run.
  const steps = setup.steps.map((x: Record<string, unknown>) => (x.label === 'Hunter' ? { ...x, on: false } : x))
    .map(({ id, label, on, kind, tool_id, url, value_path }: Record<string, unknown>) =>
      ({ id, label, on, kind, ...(tool_id ? { tool_id } : {}), ...(url ? { url, value_path } : {}) }))
  const est = await call(mcp, 'waterfall_column', {
    sheet_id: sheetId, column_name: 'Work email', add_to_column: true, steps, rows: 'any',
  })
  expect(est.steps.find((x: { label: string }) => x.label === 'Hunter').reach).toBeNull()
  const again = await call(mcp, 'waterfall_column', {
    sheet_id: sheetId, column_name: 'Work email', add_to_column: true, steps, rows: 'any', estimate_only: false,
  })
  const s = await waitDone(again.run_id)
  expect(s.waterfall.steps.find((x: { label: string }) => x.label === 'Hunter').reached).toBe(0)
  const rows = await rowsOf(api, sheetId)
  expect(rows[1]['Work email (Hunter)'] ?? '').toBe('')
  expect(rows[1]['Work email']).toBe('nobody.here@nobody.example')

  const rerun = await call(mcp, 'control_run',
    { run_type: 'waterfall', run_id: again.run_id, action: 'rerun', mode: 'all' })
  expect(rerun.run_type).toBe('waterfall')
  expect((await waitDone(rerun.run_id)).status).toBe('completed')
})

test('REST: estimate_only, the setup read, and an HTTP step reading a saved key needs the secrets scope', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const body = args(sheetId)
  delete (body as Record<string, unknown>).sheet_id
  const est = await v1.post(`/api/v1/sheets/${sheetId}/waterfall-columns`, { data: { ...body, estimate_only: true } })
  expect(est.status(), await est.text()).toBe(200)
  const started = await v1.post(`/api/v1/sheets/${sheetId}/waterfall-columns`, { data: body })
  expect(started.status(), await started.text()).toBe(202)
  await waitDone((await started.json()).run_id)
  const setup = await v1.get(`/api/v1/sheets/${sheetId}/waterfall-columns/${encodeURIComponent('Work email')}`)
  expect(setup.status()).toBe(200)
  expect((await setup.json()).result_type).toBe('email')

  const key = await api.post('/api/settings/api-keys', {
    data: { name: `wf_key_${Date.now()}`, key_type: 'bearer', key_value: 'secret-value-123456' },
  })
  expect(key.ok(), await key.text()).toBeTruthy()
  const keyName = (await key.json()).name
  const keyed = args(sheetId, {
    column_name: 'Keyed email', estimate_only: false,
    steps: [{ kind: 'http', label: 'Keyed', url: rx.url('/find?d={{domain}}'), value_path: '$.email',
      headers: { Authorization: `Bearer /${keyName}` } }],
  })
  expect(await callError(mcp, 'waterfall_column', keyed)).toMatch(/secrets/)
  const ok = await call(mcpSecrets, 'waterfall_column', keyed)
  await waitDone(ok.run_id)
  expect(rx.hitsOn('/find').some(h => h.headers.authorization === 'Bearer secret-value-123456')).toBeTruthy()
  // The setup read shows header values only with the secrets scope.
  const read = { action: 'describe', sheet_id: sheetId, column_name: 'Keyed email' }
  const hidden = await call(mcp, 'waterfall_column', read)
  expect(hidden.steps[0].headers.Authorization).toBe('…')
  expect(hidden.masked).toBeTruthy()
  expect((await call(mcpSecrets, 'waterfall_column', read)).steps[0].headers.Authorization).toBe(`Bearer /${keyName}`)
})

test('MCP: dry_run answers with each row\'s trace and writes nothing; test_step runs one step', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const dry = await call(mcp, 'waterfall_column', args(sheetId, { dry_run: true }))
  expect(dry).toMatchObject({ dry_run: true, status: 'completed' })
  expect(dry.rows.map((r: { value: string }) => r.value))
    .toEqual(['maya.chen@stripe.com', 'nobody.here@nobody.example'])
  expect(dry.rows[1].steps.map((s: { label: string }) => s.label)).toEqual(['treg finder', 'Hunter', 'Own API'])
  expect((await rowsOf(api, sheetId))[0]['Work email']).toBeUndefined()
  // One step alone, named by its label; estimate_only can't go with it.
  const one = await call(mcp, 'waterfall_column', args(sheetId, { dry_run: true, test_step: 'own api', fresh: true }))
  expect(one.test_step).toBe('Own API')
  expect(one.rows.every((r: { steps: unknown[] }) => r.steps.length === 1)).toBeTruthy()
  expect(await callError(mcp, 'waterfall_column', args(sheetId, { dry_run: true, estimate_only: true })))
    .toMatch(/estimate_only/)
  expect(await callError(mcp, 'waterfall_column', args(sheetId, { test_step: 'Own API' }))).toMatch(/dry_run/)
  // REST: the same Idempotency-Key gets the first dry run back, not a second one.
  const rest = args(sheetId, { dry_run: true, fresh: true }) as Record<string, unknown>
  delete rest.sheet_id
  const post = () => v1.post(`/api/v1/sheets/${sheetId}/waterfall-columns`,
    { headers: { 'Idempotency-Key': `dry-${sheetId}` }, data: rest })
  const first = await (await post()).json()
  const again = await (await post()).json()
  expect(again.run_id).toBe(first.run_id)
  expect(again.replayed).toBe(true)
})

test('MCP: a formula step with a verify check, and a formula check, round-trip through describe', async () => {
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const steps = [
    { kind: 'formula', label: 'Guess',
      formula: "{{full_name}}.toLowerCase().replace(' ', '.') + '@' + {{domain}}.replace('https://', '')",
      check: { kind: 'verify', accept: 'balanced' } },
    { kind: 'http', label: 'Own API', url: rx.url('/find?d={{domain}}'), value_path: '$.email',
      check: { kind: 'formula', formula: "{{value}}.includes('@')" } },
  ]
  const run = await call(mcp, 'waterfall_column', args(sheetId, { steps, estimate_only: false, fresh: true }))
  await waitDone(run.run_id)
  expect((await rowsOf(api, sheetId))[0]['Work email']).toBe('maya.chen@stripe.com')
  const setup = await call(mcp, 'waterfall_column',
    { action: 'describe', sheet_id: sheetId, column_name: 'Work email' })
  expect(setup.steps[0]).toMatchObject({ kind: 'formula', check: { kind: 'verify', accept: 'balanced' } })
  expect(setup.steps[1].check).toEqual({ kind: 'formula', formula: "{{value}}.includes('@')" })
  // A verify check needs a work email result.
  expect(await callError(mcp, 'waterfall_column', args(sheetId, {
    column_name: 'Phone', result_type: 'phone', steps: [{ ...steps[0], check: { kind: 'verify' } }],
  }))).toMatch(/email check/i)
})

test('a run webhook names the kind waterfall', async () => {
  await freshTreg(api)
  const hook = await v1.post('/api/v1/run-webhooks', { data: { url: rx.url('/hook'), every_run: true } })
  expect(hook.status(), await hook.text()).toBe(201)
  const { sheetId } = await seedCsv(api, CSV)
  const started = await call(mcp, 'waterfall_column', args(sheetId, { estimate_only: false }))
  await waitDone(started.run_id)
  const hits = await rx.waitFor('/hook', 1)
  const notice = JSON.parse(hits[hits.length - 1].body)
  expect(notice).toMatchObject({ run_id: started.run_id, kind: 'waterfall', status: 'completed' })
  const usage = readDb(db => db.prepare('SELECT kind, mode FROM run_usage WHERE run_id = ?').get(started.run_id)) as
    { kind: string; mode: string }
  expect(usage.mode).toBe('waterfall')
})

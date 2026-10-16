import { test, expect, type APIRequestContext } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, getSheet, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// Using a setup on another sheet over MCP: a chain (formula → HTTP API → formula,
// plus a clean column) saved on one sheet, priced first (the default), its
// inputs matched to differently named columns, then started: each step starts
// once the columns it reads are filled, the values land, the saved auto-run is
// turned on. Names already in the sheet are refused until renamed; a test on
// the first rows fills only those; a setup reading a saved key needs 'secrets'.

const POSTS = 'https://jsonplaceholder.typicode.com/posts/1?d={{Domain}}'

async function sheetWith(api: APIRequestContext, tableId: string | null, data: Record<string, string>[]) {
  let sheetId: string
  if (!tableId) {
    const seeded = await seedSheet(api, data.length)
    sheetId = seeded.sheetId
    tableId = seeded.tableId
  } else {
    // A new sheet starts with 3 blank rows.
    const res = await api.post(`/api/tables/${tableId}/sheets`, { data: { name: `S${Date.now() % 100000}` } })
    sheetId = (await res.json()).sheet.id
    if (data.length > 3) await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: data.length - 3 } })
  }
  for (const c of Object.keys(data[0])) await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: c } })
  const updates = data.flatMap((r, i) =>
    Object.entries(r).map(([columnName, value]) => ({ rowIndex: i, columnName, value })))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBeTruthy()
  return { tableId: tableId!, sheetId }
}

async function waitSetup(client: Client, id: string) {
  let last: any
  await expect.poll(async () => (last = await call(client, 'get_setup_run', { setup_run_id: id })).status,
    { timeout: 60_000 }).toMatch(/done|failed|cancelled/)
  return last
}

const column = async (api: APIRequestContext, sheetId: string, name: string) =>
  (await getSheet(api, sheetId)).data.rows.map((r: any) => r.data[name] ?? '')

test('a setup used on another sheet: priced, matched, run in order, auto-run on', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'setups-apply'))
  const a = await sheetWith(api, null, [{ Name: 'ada lovelace', Website: 'acme.com' }])
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  const look = await call(client, 'run_http_enrichment', { sheet_id: a.sheetId, url: POSTS,
    master_column_name: 'Lookup', response_mapping: [{ json_path: '$.id', column_name: 'Post id' }] })
  await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'http', run_id: look.run_id }))
    .status, { timeout: 30_000 }).toBe('completed')
  await call(client, 'set_auto_run', { sheet_id: a.sheetId, column: 'Lookup', enabled: true, daily_row_cap: 25 })
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Label',
    formula: '{{Domain}} + "-" + {{Post id}}' })
  await call(client, 'clean_column', { sheet_id: a.sheetId, source_column: 'Name', cleaner: 'person_name',
    column: 'Clean name' })
  const setup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Domain flow',
    columns: ['Label', 'Clean name'] })
  expect([...setup.inputs].sort()).toEqual(['Name', 'Website'])

  const b = await sheetWith(api, a.tableId, [
    { 'Full name': 'grace hopper', Site: 'navy.mil' }, { 'Full name': 'alan turing', Site: 'bletchley.uk' },
    { 'Full name': 'katherine johnson', Site: 'nasa.gov' },
  ])
  // An estimate by default; inputs without a column of their name are named.
  expect(await callError(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id })).toContain('Name')
  const inputs = { Name: 'Full name', Website: 'Site' }
  const est = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, inputs })
  expect(est.estimate.rows).toBe(3)
  expect(est.estimate.steps.find((s: any) => s.column === 'Lookup').sends_requests).toBe(true)
  expect(est.estimate.steps.filter((s: any) => s.free).map((s: any) => s.column).sort())
    .toEqual(['Clean name', 'Domain', 'Label'])
  expect((await getSheet(api, b.sheetId)).data.columns).not.toContain('Domain') // a pure read

  const started = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, inputs,
    estimate_only: false })
  const done = await waitSetup(client, started.setup_run.id)
  expect(done.status, JSON.stringify(done)).toBe('done')
  expect(done.layers).toBe(3)
  expect(await column(api, b.sheetId, 'Label')).toEqual(['navy-1', 'bletchley-1', 'nasa-1'])
  expect(await column(api, b.sheetId, 'Clean name')).toEqual(['Grace Hopper', 'Alan Turing', 'Katherine Johnson'])
  const autorun = (await getSheet(api, b.sheetId)).data.autorun
  expect(JSON.stringify(autorun)).toContain('Lookup')

  // Its columns are there now: the same names are refused until renamed.
  expect(await callError(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, inputs }))
    .toContain('already has')
  expect(await callError(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, inputs,
    names: { Nope: 'x' } })).toContain('makes no column named')
  const names = { Domain: 'Domain 2', Lookup: 'Lookup 2', Label: 'Label 2', 'Clean name': 'Clean name 2' }
  expect(await callError(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, inputs, names }))
    .toContain('"Post id"') // an output column is still taken until it's renamed too
  const renamed = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, inputs,
    names: { ...names, 'Post id': 'Post id 2' } })
  expect([...renamed.makes].sort()).toEqual(['Clean name 2', 'Domain 2', 'Label 2', 'Lookup 2', 'Post id 2'])

  // A test on the first row fills only that row, and leaves auto-run off.
  const c = await sheetWith(api, a.tableId, [{ Name: 'x y', Website: 'one.com' }, { Name: 'z w', Website: 'two.com' }])
  const test1 = await call(client, 'apply_setup', { sheet_id: c.sheetId, setup_id: setup.id, first_rows: 1,
    estimate_only: false })
  expect(test1.setup_run.test_rows).toBe(1)
  expect((await waitSetup(client, test1.setup_run.id)).status).toBe('done')
  expect(await column(api, c.sheetId, 'Post id')).toEqual(['1', '', ''])
  const cAutorun = JSON.stringify((await getSheet(api, c.sheetId)).data.autorun ?? {})
  for (const col of ['Lookup', 'Domain', 'Label', 'Clean name']) expect(cAutorun).not.toContain(`"${col}"`)
  expect(await callError(client, 'control_setup_run', { setup_run_id: test1.setup_run.id, action: 'pause' }))
    .toContain('done')

  // A setup whose request reads a saved key: a token without 'secrets' can't use it.
  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (k.name === 'setup_e2e_key') await api.delete(`/api/settings/api-keys/${k.id}`)
  await api.post('/api/settings/api-keys', { data: { name: 'setup_e2e_key', key_type: 'api_key',
    key_value: 'e2e-key-value-0123456789' } })
  const keyed = await call(client, 'run_http_enrichment', { sheet_id: a.sheetId, url: POSTS,
    headers: { 'X-Key': '{{setup_e2e_key}}' }, master_column_name: 'Keyed',
    response_mapping: [{ json_path: '$.userId', column_name: 'User id' }] }).catch(e => String(e))
  expect(String(keyed)).toMatch(/secrets/) // this token can't even start it
  const secretClient = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run', 'secrets'], 'setups-sec'))
  const k = await call(secretClient, 'run_http_enrichment', { sheet_id: a.sheetId, url: POSTS,
    headers: { 'X-Key': '{{setup_e2e_key}}' }, master_column_name: 'Keyed',
    response_mapping: [{ json_path: '$.userId', column_name: 'User id' }] })
  await expect.poll(async () => (await call(secretClient, 'get_run_status', { run_type: 'http', run_id: k.run_id }))
    .status, { timeout: 30_000 }).toBe('completed')
  const keyedSetup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Keyed', columns: ['User id'],
    include_upstream: false })
  expect(keyedSetup.keys).toEqual(['setup_e2e_key'])
  expect(await callError(client, 'apply_setup', { sheet_id: c.sheetId, setup_id: keyedSetup.id }))
    .toMatch(/secrets/)
  const ok = await call(secretClient, 'apply_setup', { sheet_id: c.sheetId, setup_id: keyedSetup.id })
  expect(ok.estimate.rows).toBe(3)
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
})

test('a setup run pauses between steps, resumes, stops; an AI step starts on its model', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'setups-control'))
  const a = await sheetWith(api, null, [{ Website: 'acme.com' }])
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Label', formula: '{{Domain}} + "!"' })
  const setup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Two steps', columns: ['Label'] })
  const b = await sheetWith(api, a.tableId, [{ Website: 'one.com' }, { Website: 'two.com' }, { Website: 'three.com' }])
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  // Paused right after its start: the second step waits, whatever the first does.
  const run = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, estimate_only: false }))
    .setup_run
  expect((await call(client, 'control_setup_run', { setup_run_id: run.id, action: 'pause' })).status).toBe('paused')
  await sleep(2500)
  const paused = await call(client, 'get_setup_run', { setup_run_id: run.id })
  expect(paused.status).toBe('paused')
  expect(paused.steps.find((s: any) => s.column === 'Label').state).toBe('waiting')
  expect((await getSheet(api, b.sheetId)).data.columns).not.toContain('Label')
  await call(client, 'control_setup_run', { setup_run_id: run.id, action: 'resume' })
  expect((await waitSetup(client, run.id)).status).toBe('done')
  expect(await column(api, b.sheetId, 'Label')).toEqual(['one!', 'two!', 'three!'])

  // Stopped right after its start: no later step starts.
  const again = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, estimate_only: false,
    names: { Domain: 'Domain 2', Label: 'Label 2' } })).setup_run
  expect((await call(client, 'control_setup_run', { setup_run_id: again.id, action: 'cancel' })).status)
    .toBe('cancelled')
  await sleep(2000)
  expect((await getSheet(api, b.sheetId)).data.columns).not.toContain('Label 2')

  // Resuming a setup whose later step reads a saved key needs 'secrets'.
  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (k.name === 'setup_e2e_key2') await api.delete(`/api/settings/api-keys/${k.id}`)
  await api.post('/api/settings/api-keys', { data: { name: 'setup_e2e_key2', key_type: 'api_key',
    key_value: 'e2e-key-value-9876543210' } })
  const secret = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run', 'secrets'], 'setups-sec2'))
  const keyedRun = await call(secret, 'run_http_enrichment', { sheet_id: a.sheetId,
    url: 'https://jsonplaceholder.typicode.com/posts/1?d={{Domain}}', headers: { 'X-Key': '{{setup_e2e_key2}}' },
    master_column_name: 'Keyed', response_mapping: [{ json_path: '$.userId', column_name: 'User id' }] })
  await expect.poll(async () => (await call(secret, 'get_run_status', { run_type: 'http', run_id: keyedRun.run_id }))
    .status, { timeout: 30_000 }).toBe('completed')
  const keyed = await call(secret, 'save_setup', { sheet_id: a.sheetId, name: 'Keyed chain', columns: ['User id'] })
  const keyedRun2 = (await call(secret, 'apply_setup', { sheet_id: b.sheetId, setup_id: keyed.id,
    names: { Domain: 'Domain 3' }, estimate_only: false })).setup_run
  await call(secret, 'control_setup_run', { setup_run_id: keyedRun2.id, action: 'pause' })
  expect(await callError(client, 'control_setup_run', { setup_run_id: keyedRun2.id, action: 'resume' }))
    .toMatch(/secrets/)
  await call(secret, 'control_setup_run', { setup_run_id: keyedRun2.id, action: 'resume' })
  expect((await waitSetup(secret, keyedRun2.id)).status).toBe('done')
  expect(await column(api, b.sheetId, 'User id')).toEqual(['1', '1', '1'])

  // An AI step: started on the model it was saved with (a fake key fails each row for free).
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    const ai = await call(client, 'run_ai_column', { sheet_id: a.sheetId, column_name: 'Fit',
      prompt: 'Is /domain a fit?', model: 'deepseek/deepseek-v4-flash' })
    await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'ai', run_id: ai.run_id }))
      .status, { timeout: 30_000 }).toMatch(/completed|failed/)
    const aiSetup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Fit', columns: ['Fit (Output)'],
      include_upstream: false })
    const est = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: aiSetup.id })
    expect(est.estimate.steps[0].kind).toBe('ai')
    const started = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: aiSetup.id,
      estimate_only: false })).setup_run
    const done = await waitSetup(client, started.id)
    expect(done.steps[0].run_id).toBeTruthy()
    expect((await getSheet(api, b.sheetId)).data.columns).toContain('Fit (Output)')
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
})

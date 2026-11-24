import { test, expect } from '@playwright/test'
import { BASE, authedApi, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { sheetWith } from './helpers-setups'

// A saved setup called on items without a sheet (services/setup-call.ts), over MCP and REST: a free chain (a
// formula and a clean column) saved from a sheet; call_setup prices it by default and makes nothing; started, it
// runs on a working table no list shows, and get_setup_call answers each item's outputs in the order sent. REST
// does the same (estimate_only defaults to false there), refuses an item with a name the setup doesn't read, a
// token without "run", and answers 404 for a call that isn't there. control_setup_run takes a call's id.

test('a setup called on items: priced, run without a sheet, each item\'s outputs', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'setup-calls')
  const client = await mcpClient(token)
  const a = await sheetWith(api, null, [{ Name: 'ada lovelace', Website: 'acme.com' }])
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  await call(client, 'clean_column', { sheet_id: a.sheetId, source_column: 'Name', cleaner: 'person_name',
    column: 'Clean name' })
  const setup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Call me',
    columns: ['Domain', 'Clean name'] })
  expect([...setup.inputs].sort()).toEqual(['Name', 'Website'])
  const tables = async () => (await call(client, 'list_tables', {})).tables.length
  const before = await tables()

  // MCP: an estimate by default, nothing made.
  const items = [{ Name: 'grace hopper', Website: 'navy.mil' }, { Website: 'nasa.gov' }, { Name: 'alan turing' }]
  const est = await call(client, 'call_setup', { setup_id: setup.id, items })
  expect(est.items).toBe(3)
  expect([...est.makes].sort()).toEqual(['Clean name', 'Domain'])
  expect(est.setup_call).toBeUndefined()
  expect(await tables()).toBe(before)

  // Started: hidden while it runs, each item's outputs once it's done.
  const started = (await call(client, 'call_setup', { setup_id: setup.id, items, estimate_only: false })).setup_call
  expect(started.items).toBe(3)
  expect(await tables()).toBe(before)
  let done: any
  await expect.poll(async () => (done = await call(client, 'get_setup_call',
    { setup_call_id: started.id, wait_seconds: 5 })).status, { timeout: 60_000 }).toBe('done')
  expect(done.results).toEqual([
    { item: 0, outputs: { Domain: 'navy', 'Clean name': 'Grace Hopper' } },
    { item: 1, outputs: { Domain: 'nasa', 'Clean name': null } },
    { item: 2, outputs: { Domain: null, 'Clean name': 'Alan Turing' } },
  ])
  expect(done.keep_until).toBeTruthy()
  expect(await tables()).toBe(before)
  // Its id is a setup run's.
  expect((await call(client, 'get_setup_run', { setup_run_id: started.id })).status).toBe('done')
  expect(await callError(client, 'call_setup', { setup_id: setup.id, items: [{ Nmae: 'x' }] }))
    .toContain('isn\'t an input of this setup')

  // REST: estimate_only defaults to false here.
  const auth = { Authorization: `Bearer ${token}` }
  const rest = await api.post(`${BASE}/api/v1/setups/${setup.id}/calls`, { headers: auth,
    data: { items: [{ Name: 'katherine johnson', Website: 'nasa.gov' }] } })
  expect(rest.status()).toBe(201)
  const restCall = (await rest.json()).setup_call
  let restDone: any
  await expect.poll(async () => (restDone = await (await api.get(`${BASE}/api/v1/setup-calls/${restCall.id}`,
    { headers: auth })).json()).status, { timeout: 60_000 }).toBe('done')
  expect(restDone.results).toEqual([{ item: 0, outputs: { Domain: 'nasa', 'Clean name': 'Katherine Johnson' } }])
  const priced = await api.post(`${BASE}/api/v1/setups/${setup.id}/calls`, { headers: auth,
    data: { items: [{ Name: 'x' }], estimate_only: true } })
  expect(priced.status()).toBe(200)
  expect((await priced.json()).items).toBe(1)
  expect((await api.post(`${BASE}/api/v1/setups/${setup.id}/calls`, { headers: auth,
    data: { items: [{ Nmae: 'x' }] } })).status()).toBe(400)
  expect((await api.post(`${BASE}/api/v1/setups/${setup.id}/calls`, { headers: auth,
    data: { items: [] } })).status()).toBe(400)
  expect((await api.get(`${BASE}/api/v1/setup-calls/nope`, { headers: auth })).status()).toBe(404)
  const readOnly = await makeAccessToken(api, ['read'], 'setup-calls-read')
  expect((await api.post(`${BASE}/api/v1/setups/${setup.id}/calls`, { headers: { Authorization: `Bearer ${readOnly}` },
    data: { items: [{ Name: 'x' }] } })).status()).toBe(403)
  expect((await (await api.get('/api/tables')).json()).some((t: any) => t.name.startsWith('Setup call')))
    .toBe(false)

  // control_setup_run takes a call's id (a finished one says it has ended).
  expect(await callError(client, 'control_setup_run', { setup_run_id: started.id, action: 'cancel' }))
    .toContain('already ended')
})

// A file's rows as a setup call's items: an upload link with setup_id (max_cost_usd required) starts the call once
// the file is in, its results page with next_from, a download link with setup_call_id saves them; REST takes the file
// as multipart.
test('a setup called on a file: an upload link and REST, results paged and downloaded', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'setup-calls-file')
  const client = await mcpClient(token)
  const a = await sheetWith(api, null, [{ Name: 'ada lovelace' }])
  await call(client, 'clean_column', { sheet_id: a.sheetId, source_column: 'Name', cleaner: 'person_name',
    column: 'Clean name' })
  const setup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: `File call ${Date.now()}`,
    columns: ['Clean name'] })
  expect(await callError(client, 'create_upload_link', { setup_id: setup.id })).toContain('max_cost_usd')
  expect(await callError(client, 'create_upload_link', { sheet_id: a.sheetId, setup_id: setup.id, max_cost_usd: 1 }))
    .toContain('Pass sheet_id, or setup_id')
  const link = await call(client, 'create_upload_link', { setup_id: setup.id, max_cost_usd: 1 })
  const names = Array.from({ length: 150 }, (_, i) => `person ${i}`)
  const csv = `Name,Extra\n${names.map(n => `${n},x`).join('\n')}\n`
  const up = await api.put(link.upload_url, { data: Buffer.from(csv), headers: { 'Content-Type': 'text/csv' } })
  expect(up.status()).toBe(201)
  const started = (await up.json()).setup_call
  expect(started.items).toBe(150)
  let done: any
  await expect.poll(async () => (done = await call(client, 'get_setup_call',
    { setup_call_id: started.id, wait_seconds: 5 })).status, { timeout: 60_000 }).toBe('done')
  expect(done.results.length).toBe(100)
  expect(done.next_from).toBe(100)
  const rest = await call(client, 'get_setup_call', { setup_call_id: started.id, results_from: done.next_from })
  expect(rest.results.map((r: any) => r.outputs['Clean name'])).toEqual(names.slice(100).map(n =>
    n.replace(/^p/, 'P')))
  expect(rest.next_from).toBeNull()
  const dl = await call(client, 'create_download_link', { setup_call_id: started.id })
  const file = await (await api.get(dl.download_url)).text()
  expect(file.split('\n')[0]).toContain('Clean name')
  expect(file).toContain('Person 149')

  // REST: multipart, max_cost_usd required.
  const auth = { Authorization: `Bearer ${token}` }
  const multipart = (extra: Record<string, string>) => ({ headers: auth, multipart: {
    file: { name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('Name\ngrace hopper\n') }, ...extra } })
  expect((await api.post(`${BASE}/api/v1/setups/${setup.id}/calls/file`, multipart({}))).status()).toBe(400)
  const restUp = await api.post(`${BASE}/api/v1/setups/${setup.id}/calls/file`, multipart({ max_cost_usd: '1' }))
  expect(restUp.status()).toBe(201)
  const restCall = (await restUp.json()).setup_call
  let restDone: any
  await expect.poll(async () => (restDone = await (await api.get(
    `${BASE}/api/v1/setup-calls/${restCall.id}?limit=1`, { headers: auth })).json()).status, { timeout: 60_000 })
    .toBe('done')
  expect(restDone.results).toEqual([{ item: 0, outputs: { 'Clean name': 'Grace Hopper' } }])
  expect((await (await api.get('/api/tables')).json()).some((t: any) => t.name.startsWith('Setup call')))
    .toBe(false)
})

import { test, expect } from '@playwright/test'
import { authedApi, getSheet, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { POSTS, sheetWith, waitSetup, column } from './helpers-setups'

// Using a setup on another sheet over MCP: a chain (formula → HTTP API → formula,
// plus a clean column) saved on one sheet, priced first (the default), its
// inputs matched to differently named columns, then started: each step starts
// once the columns it reads are filled, the values land, the saved auto-run is
// turned on. Used again where its columns are, its steps carry them on (only
// the rows not done yet); other names already in the sheet are refused until
// renamed; a test on the first rows fills only those, and using it again on
// every row then fills the rest; a setup reading a saved key needs 'secrets'.

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

  // Its columns are there now: used again, every step carries its column on, with nothing left to do.
  const again = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, inputs })
  expect([...again.carries_on].sort()).toEqual(['Clean name', 'Domain', 'Label', 'Lookup'])
  expect(again.estimate.steps.find((s: any) => s.column === 'Lookup')).toMatchObject({ mode: 'again', rows: 0 })
  // A column of another kind under a step's name is still taken.
  await api.post(`/api/sheets/${b.sheetId}/columns`, { data: { columnName: 'Other' } })
  expect(await callError(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, inputs,
    names: { 'Clean name': 'Other' } })).toContain('already has')
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

  // Used again on every row: the steps carry on, the HTTP API step only on the rows the test left.
  const rest = await call(client, 'apply_setup', { sheet_id: c.sheetId, setup_id: setup.id })
  expect(rest.estimate.steps.find((s: any) => s.column === 'Lookup')).toMatchObject({ mode: 'again', rows: 2 })
  const restRun = await call(client, 'apply_setup', { sheet_id: c.sheetId, setup_id: setup.id,
    estimate_only: false })
  expect(restRun.setup_run.choices.inputs).toEqual({ Name: 'Name', Website: 'Website' })
  const restDone = await waitSetup(client, restRun.setup_run.id)
  expect(restDone.status, JSON.stringify(restDone)).toBe('done')
  expect(restDone.steps.every((s: any) => s.mode === 'again')).toBe(true)
  expect(await column(api, c.sheetId, 'Post id')).toEqual(['1', '1', '1'])
  expect((await column(api, c.sheetId, 'Label')).slice(0, 2)).toEqual(['one-1', 'two-1'])
  const lookupRun = restDone.steps.find((s: any) => s.column === 'Lookup').run_id
  expect((await call(client, 'get_run_status', { run_type: 'http', run_id: lookupRun })).total_rows).toBe(2)
  // A run on every row turns the saved auto-run on.
  expect(JSON.stringify((await getSheet(api, c.sheetId)).data.autorun ?? {})).toContain('Lookup')

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

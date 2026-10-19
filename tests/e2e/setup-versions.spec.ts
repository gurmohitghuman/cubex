// Over 200 lines: one spec of setup versions over REST and MCP, its tests sharing a receiver, tokens and helpers.
import { test, expect, type APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { Receiver } from './helpers-receiver'

// Setup versions over REST and MCP: a version keeps how a sheet's columns are
// set up (an HTTP API column, an AI column run on a fake OpenRouter key so
// every row fails for free, a formula column, a description); after they
// change, a comparison says so field by field; restoring needs 'run', adds the
// deleted formula column back empty, gives the HTTP and AI columns their old
// setup without running anything (get_sheet says "restored", list_runs leaves
// it out), and their next run uses it; History lists the save and the restore;
// a request reading a saved key needs 'secrets' to restore.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
let token: string
const FAKE_KEY = 'sk-or-v1-invalid-e2e'

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  token = await makeToken(api, ['read', 'write', 'run'], 'setup versions spec')
  v1 = await bearer(token)
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

async function sheetWith(csv: string): Promise<string> {
  const s = await seedSheet(api, 1)
  expect((await importCsv(api, s.sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  return s.sheetId
}
async function httpRun(sheetId: string, path: string): Promise<string> {
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url(`${path}?d={{Domain}}`), method: 'POST', master_column_name: 'Call',
    response_mapping: [{ json_path: '$.ok', column_name: 'OK' }],
  } })
  expect(res.status(), await res.text()).toBe(202)
  const runId = (await res.json()).run_id as string
  await waitForTerminal(v1, `/api/v1/http-runs/${runId}`)
  return runId
}
const details = async (sheetId: string) => {
  const client = await mcpClient(token)
  const sheet = await call(client, 'get_sheet', { sheet_id: sheetId })
  return new Map<string, any>(sheet.column_details.map((d: any) => [d.name, d]))
}

test('REST and MCP: save, compare, restore without running, then the next run uses it', async () => {
  test.setTimeout(150_000)
  const sheetId = await sheetWith('Name,Website\nAda,acme.com\nBo,navy.mil\n')
  const client = await mcpClient(token)
  rx.on('/v1', { status: 200, body: '{"ok":"one"}' })
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  await httpRun(sheetId, '/v1')
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: FAKE_KEY } })).ok()).toBeTruthy()
  try {
    const ai = await call(client, 'run_ai_column', { sheet_id: sheetId, column_name: 'Fit', prompt: 'Is /name a fit?',
      model: 'deepseek/deepseek-v4-flash' })
    await waitForTerminal(v1, `/api/v1/ai-runs/${ai.run_id}`)
    await call(client, 'set_description', { sheet_id: sheetId, column: 'Name', description: 'Who it is' })

    const saved = await v1.post(`/api/v1/sheets/${sheetId}/setup-versions`, { data: { name: 'Launch' } })
    expect(saved.status(), await saved.text()).toBe(201)
    const version = (await saved.json()).version
    expect(version).toMatchObject({ name: 'Launch', auto: false, columns: 6, filled: 3 })
    const dup = await v1.post(`/api/v1/sheets/${sheetId}/setup-versions`, { data: { name: 'launch' } })
    expect(dup.status()).toBe(409)

    // The sheet changes: the AI column runs another prompt, the formula column the HTTP column reads is
    // deleted (its request now reads a deleted column: a rerun is refused), the description is edited.
    const ai2 = await call(client, 'run_ai_column', { sheet_id: sheetId, column_name: 'Fit', prompt: 'Rate /name',
      model: 'deepseek/deepseek-v4-flash' })
    await waitForTerminal(v1, `/api/v1/ai-runs/${ai2.run_id}`)
    expect((await v1.delete(`/api/v1/sheets/${sheetId}/columns/Domain`)).ok()).toBeTruthy()
    await call(client, 'set_description', { sheet_id: sheetId, column: 'Name', description: 'Changed' })
    const runsBefore = (await call(client, 'list_runs', { sheet_id: sheetId })).runs.length

    const compared = await (await v1.get(`/api/v1/sheets/${sheetId}/setup-versions/${version.id}`)).json()
    const by = new Map<string, any>(compared.columns.map((c: any) => [c.column, c]))
    expect(compared.dry_run).toBe(true)
    expect(by.get('Domain')).toMatchObject({ action: 'add_back', kind: 'formula' })
    expect(by.get('Fit (Output)').fields).toEqual([{ field: 'Prompt', version: 'Is /name a fit?', now: 'Rate /name' }])
    expect(by.get('Call').fields).toEqual([{ field: 'Reads columns that were deleted', version: null, now: 'Domain' }])
    const callRun = (await details(sheetId)).get('Call').fill.run_id
    const stale = await v1.post(`/api/v1/http-runs/${callRun}/rerun`, { data: { mode: 'all' } })
    expect(stale.status(), await stale.text()).toBe(400)
    expect(by.get('Name').fields).toEqual([{ field: 'Description', version: 'Who it is', now: 'Changed' }])

    // Restoring needs 'run'; a REST or MCP restore is a dry run unless told otherwise.
    const writer = await bearer(await makeToken(api, ['read', 'write'], 'setup versions writer'))
    const restoreUrl = `/api/v1/sheets/${sheetId}/setup-versions/${version.id}/restore`
    const restDry = await writer.post(restoreUrl)
    expect(restDry.status(), await restDry.text()).toBe(200)
    expect((await restDry.json()).dry_run).toBe(true)
    const refused = await writer.post(restoreUrl, { data: { dry_run: false } })
    expect(refused.status()).toBe(403)
    expect((await refused.json()).error).toMatch(/'run' scope/)
    await writer.dispose()
    const dry = await call(client, 'restore_setup_version', { sheet_id: sheetId, version_id: version.id })
    expect(dry.dry_run).toBe(true)
    expect((await details(sheetId)).has('Domain')).toBe(false)

    const hitsBefore = rx.hits.length
    const done = await call(client, 'restore_setup_version', { sheet_id: sheetId, version_id: version.id,
      dry_run: false })
    expect(done.saved_before).toMatchObject({ name: 'Before restoring: Launch', auto: true })
    expect(done.message).toMatch(/^Restored\. 1 column added back \(empty\), 3 columns set up as they were\. /)
    expect(rx.hits.length).toBe(hitsBefore)
    const d = await details(sheetId)
    expect(d.get('Domain')).toMatchObject({ kind: 'formula' })
    expect(d.get('Fit (Output)').fill).toMatchObject({ run_status: 'restored', prompt: 'Is /name a fit?' })
    expect(d.get('Call').fill.run_status).toBe('restored')
    expect(d.get('Call').fill.url).toContain('/v1?d={{Domain}}')
    expect((await call(client, 'list_runs', { sheet_id: sheetId })).runs.length).toBe(runsBefore)
    const rows = await (await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { limit: 10 } })).json()
    expect(rows.rows.map((r: any) => r.data.Domain ?? '')).toEqual(['', ''])
    expect(rows.rows.map((r: any) => r.data.OK)).toEqual(['one', 'one'])

    // The column's next run uses the restored request.
    rx.on('/v1', { status: 200, body: '{"ok":"again"}' })
    const rerun = await v1.post(`/api/v1/http-runs/${d.get('Call').fill.run_id}/rerun`, { data: { mode: 'all' } })
    expect(rerun.status(), await rerun.text()).toBe(202)
    await waitForTerminal(v1, `/api/v1/http-runs/${(await rerun.json()).run_id}`)
    expect(rx.hitsOn('/v1').length).toBeGreaterThan(0)
    const after = await (await v1.post(`/api/v1/sheets/${sheetId}/rows/query`, { data: { limit: 10 } })).json()
    expect(after.rows.map((r: any) => r.data.OK)).toEqual(['again', 'again'])
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }

  const history = await (await v1.get(`/api/v1/sheets/${sheetId}/history`)).json()
  const summaries = (history.changes as Array<{ action: string; summary: string }>)
    .filter(c => c.action.startsWith('setup_version_')).map(c => c.summary)
  expect(summaries).toEqual(['Restored the setup version "Launch"', 'Saved the setup version "Launch"'])
  const listed = await call(client, 'list_setup_versions', { sheet_id: sheetId })
  expect(listed.versions.map((v: any) => v.name)).toEqual(['Before restoring: Launch', 'Launch'])
  const renamed = await call(client, 'manage_setup_version', { sheet_id: sheetId, action: 'rename',
    version_id: listed.versions[1].id, name: 'First launch' })
  expect(renamed.version.name).toBe('First launch')
  await call(client, 'manage_setup_version', { sheet_id: sheetId, action: 'delete', version_id: listed.versions[0].id })
  expect((await call(client, 'list_setup_versions', { sheet_id: sheetId })).versions.map((v: any) => v.name))
    .toEqual(['First launch'])
  expect(await callError(client, 'manage_setup_version', { sheet_id: sheetId, action: 'save' }))
    .toMatch(/Give the version a name/)
})

test("a request reading a saved key: restoring it needs the 'secrets' scope", async () => {
  test.setTimeout(90_000)
  const sheetId = await sheetWith('Name,Domain\nAda,acme\n')
  const keyName = `sv_key_${Date.now() % 100000}`
  const key = await api.post('/api/settings/api-keys',
    { data: { name: keyName, key_type: 'api_key', key_value: 'secret-value-123' } })
  expect(key.status(), await key.text()).toBe(201)
  const secretToken = await makeToken(api, ['read', 'write', 'run', 'secrets'], 'setup versions secrets')
  const withSecrets = await bearer(secretToken)
  try {
    rx.on('/k', { status: 200, body: '{"ok":"k"}' })
    const res = await withSecrets.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
      url: rx.url('/k?d={{Domain}}'), method: 'POST', master_column_name: 'Call',
      headers: { 'X-Key': `{{${keyName}}}` },
      response_mapping: [{ json_path: '$.ok', column_name: 'OK' }],
    } })
    expect(res.status(), await res.text()).toBe(202)
    await waitForTerminal(withSecrets, `/api/v1/http-runs/${(await res.json()).run_id}`)
    const client = await mcpClient(token)
    const saved = await call(client, 'manage_setup_version', { sheet_id: sheetId, action: 'save', name: 'Keyed' })
    expect((await v1.delete(`/api/v1/sheets/${sheetId}/columns/Domain`)).ok()).toBeTruthy()

    // The comparison names the header, never its value.
    const compared = await call(client, 'list_setup_versions', { sheet_id: sheetId, version_id: saved.version.id })
    expect(JSON.stringify(compared)).not.toContain('secret-value-123')
    expect(await callError(client, 'restore_setup_version', { sheet_id: sheetId, version_id: saved.version.id,
      dry_run: false })).toMatch(/needs the 'secrets' scope/)
    const ok = await call(await mcpClient(secretToken), 'restore_setup_version', { sheet_id: sheetId,
      version_id: saved.version.id, dry_run: false })
    expect(ok.nothing).toBe(false)
  } finally {
    await withSecrets.dispose()
    const keys = await (await api.get('/api/settings/api-keys')).json()
    for (const k of keys as Array<{ id: string; name: string }>) {
      if (k.name === keyName) await api.delete(`/api/settings/api-keys/${k.id}`)
    }
  }
})
